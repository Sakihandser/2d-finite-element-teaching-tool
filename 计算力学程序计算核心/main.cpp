#include <exception>
#include <iostream>
#include <cmath>
#include <array>
#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstdlib>
#include<Eigen/Dense>
#include <Eigen/Sparse>
#include <Eigen/SparseCholesky>
#include <iomanip>
#include <iterator>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <vector>

#include "CalculationData.h"
#include "CalculationBinaryIO.h"
#include "CalculationResultExport.h"
#include "ElementCalculations.h"
#include "GpuElementBackend.h"

#ifdef _OPENMP
#include <omp.h>
#endif

using namespace Eigen;
using namespace std;


namespace {

std::string ReadEnvironmentVariable(const char* name)
{
#ifdef _WIN32
	char* value = nullptr;
	std::size_t valueLength = 0;
	if (_dupenv_s(&value, &valueLength, name) != 0 || value == nullptr)
	{
		return "";
	}
	std::string result(value);
	std::free(value);
	return result;
#else
	const char* value = std::getenv(name);
	return value == nullptr ? "" : std::string(value);
#endif
}

bool IsVerboseOutputEnabled(int argc, char* argv[])
{
	for (int i = 1; i < argc; ++i)
	{
		if (std::string(argv[i]) == "--verbose")
		{
			return true;
		}
	}

	std::string normalized = ReadEnvironmentVariable("FEM_VERBOSE");
	std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch)
	{
		return static_cast<char>(std::tolower(ch));
	});
	return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

bool HasCommandLineArgument(int argc, char* argv[], const char* expected)
{
	for (int i = 1; i < argc; ++i)
	{
		if (std::string(argv[i]) == expected)
		{
			return true;
		}
	}
	return false;
}

int DetermineParallelWorkerCount(std::size_t elementCount)
{
#ifdef _OPENMP
	const int maximumThreads = std::max(1, omp_get_max_threads());
	int workerCount = std::min(maximumThreads, 8);
	const std::string configuredValue = ReadEnvironmentVariable("FEM_THREADS");
	if (!configuredValue.empty())
	{
		int requestedThreads = 0;
		const auto result = std::from_chars(
			configuredValue.data(), configuredValue.data() + configuredValue.size(), requestedThreads);
		if (result.ec == std::errc{} && result.ptr == configuredValue.data() + configuredValue.size())
		{
			workerCount = std::clamp(requestedThreads, 1, maximumThreads);
		}
	}
	// 小模型的线程启动成本通常高于并行收益。
	return elementCount >= 2048 ? workerCount : 1;
#else
	(void)elementCount;
	return 1;
#endif
}

}  // namespace


int main(int argc, char* argv[])
{
	const bool verboseOutput = IsVerboseOutputEnabled(argc, argv);
	const bool binaryIpc = HasCommandLineArgument(argc, argv, "--binary-ipc");
	const bool writeTextFiles = !binaryIpc || HasCommandLineArgument(argc, argv, "--write-text");
	std::ostream& statusOutput = binaryIpc ? std::cerr : std::cout;

	fem::CalculationModel calculationModel;
	std::filesystem::path inputPath;

	try
	{
		if (binaryIpc)
		{
			fem::ConfigureBinaryStandardStreams();
			calculationModel = fem::LoadCalculationModelBinary(std::cin);
			if (writeTextFiles)
			{
				inputPath = fem::FindDefaultCalculationInputPath();
				calculationModel.sourcePath = inputPath;
			}
		}
		else
		{
			// 兼容直接运行 exe：继续从 calculation-data/calculation-input.txt 导入。
			inputPath = fem::FindDefaultCalculationInputPath();
			calculationModel = fem::LoadCalculationInput(inputPath);
		}

		// 打印导入结果，方便检查节点、单元、材料、载荷和警告信息是否正确。
		if (verboseOutput)
		{
			fem::PrintCalculationModel(calculationModel, statusOutput);
		}
	}
	catch (const std::exception& error)
	{
		std::cerr << "Failed to import calculation input: " << error.what() << '\n';
		return 1;
	}


	// 计算节点总数。节点数据由前端导出的 calculation-input.txt 读入。
	const int nodeCount = static_cast<int>(calculationModel.nodes.size());

	// nodeCoordinate 用一维向量存储二维坐标：第 i 个节点的 x 在 2*i，y 在 2*i+1。
	VectorXd nodeCoordinate(2 * nodeCount);
	nodeCoordinate.setZero();

	// 节点编号到内部索引/自由度号的映射。
	// coordinateIndex 用于查坐标；dofUx/dofUy 用于把单元刚度装配到总体自由度矩阵。
	struct NodeIndexData
	{
		int coordinateIndex = 0;
		int dofUx = 0;
		int dofUy = 0;
	};

	unordered_map<int, NodeIndexData> nodeIndexByNo;
	nodeIndexByNo.reserve(calculationModel.nodes.size());

	// globalDofCount 是总体自由度数量，由输入文件中的最大自由度编号确定。
	int globalDofCount = 0;

	// 遍历节点：检查自由度编号、建立 nodeNo -> NodeIndexData 映射，并保存节点坐标。
	for (int i = 0; i < nodeCount; i++)
	{
		const auto& node = calculationModel.nodes[i];
		if (node.dofUx <= 0 || node.dofUy <= 0)
		{
			cerr << "Node " << node.nodeNo << " has invalid dof number." << '\n';
			return 1;
		}

		const NodeIndexData nodeIndex = { i, node.dofUx - 1, node.dofUy - 1 };
		if (!nodeIndexByNo.emplace(node.nodeNo, nodeIndex).second)
		{
			cerr << "Duplicate node number: " << node.nodeNo << '\n';
			return 1;
		}
		nodeCoordinate(2 * i) = node.x;
		nodeCoordinate(2 * i + 1) = node.y;
		if (node.dofUx > globalDofCount)
		{
			globalDofCount = node.dofUx;
		}
		if (node.dofUy > globalDofCount)
		{
			globalDofCount = node.dofUy;
		}
	}

	// 总位移向量，长度等于总自由度数量。后续求解 K*u=F 后会写入这里。
	VectorXd nodeDisplacement(globalDofCount);
	nodeDisplacement.setZero();

	// 总载荷向量，长度等于总自由度数量。后续会把节点力和等效节点力装配进来。
	VectorXd nodeForce(globalDofCount);
	nodeForce.setZero();

	// 固定自由度标记。对角元素改 1 法需要把固定自由度所在行/列清零，再把对角线设为 1。
	vector<unsigned char> fixedDof(globalDofCount, 0);

	// 初始化节点力和固定边界。
	// 这里使用 dofUx/dofUy 映射写入总体自由度，避免用 nodeNo 假设自由度编号连续等于节点编号。
	for (const auto& node : calculationModel.nodes)
	{
		const auto foundNode = nodeIndexByNo.find(node.nodeNo);
		if (foundNode == nodeIndexByNo.end())
		{
			cerr << "Node " << node.nodeNo << " not found in node index map." << '\n';
			return 1;
		}

		const NodeIndexData& nodeIndex = foundNode->second;
		nodeForce(nodeIndex.dofUx) = node.forceX;
		nodeForce(nodeIndex.dofUy) = node.forceY;

		if (node.fixUx == 1)
		{
			fixedDof[nodeIndex.dofUx] = true;
		}
		if (node.fixUy == 1)
		{
			fixedDof[nodeIndex.dofUy] = true;
		}
	}
	// 单元连接关系、坐标和全局自由度只解析一次，供刚度装配与后处理共同复用。
	struct PreparedElementData
	{
		array<double, 6> coordinates{};
		array<int, 6> globalDofs{};
		int resultIndex = -1;
	};

	vector<PreparedElementData> preparedElements(calculationModel.elements.size());
	vector<bool> usedResultSlots(calculationModel.elements.size(), false);
	for (std::size_t elementIndex = 0; elementIndex < calculationModel.elements.size(); ++elementIndex)
	{
		const auto& element = calculationModel.elements[elementIndex];
		if (element.area <= 0.0)
		{
			cerr << "Element " << element.elementNo << " has non-positive area: " << element.area << '\n';
			return 1;
		}

		const int resultIndex = element.elementNo - 1;
		if (resultIndex < 0 || resultIndex >= static_cast<int>(calculationModel.elements.size()) || usedResultSlots[resultIndex])
		{
			cerr << "Element " << element.elementNo << " has invalid or duplicate result index." << '\n';
			return 1;
		}
		usedResultSlots[resultIndex] = true;

		const array<int, 3> nodeIds = { element.node1, element.node2, element.node3 };
		auto& prepared = preparedElements[elementIndex];
		prepared.resultIndex = resultIndex;
		for (int localNode = 0; localNode < 3; ++localNode)
		{
			const auto foundNode = nodeIndexByNo.find(nodeIds[localNode]);
			if (foundNode == nodeIndexByNo.end())
			{
				cerr << "Element " << element.elementNo << " references missing node " << nodeIds[localNode] << '\n';
				return 1;
			}
			const NodeIndexData& nodeIndex = foundNode->second;
			prepared.coordinates[2 * localNode] = nodeCoordinate(2 * nodeIndex.coordinateIndex);
			prepared.coordinates[2 * localNode + 1] = nodeCoordinate(2 * nodeIndex.coordinateIndex + 1);
			prepared.globalDofs[2 * localNode] = nodeIndex.dofUx;
			prepared.globalDofs[2 * localNode + 1] = nodeIndex.dofUy;
		}
	}
	const int parallelWorkerCount = DetermineParallelWorkerCount(preparedElements.size());

	// 总体刚度矩阵 K 是稀疏矩阵。有限元总体刚度矩阵大多数位置为 0，用稀疏存储可节省内存。
	SparseMatrix<double> K(globalDofCount, globalDofCount);

	vector<fem::ElementStiffnessMatrix> elementStiffnessMatrices(preparedElements.size());
	vector<vector<Triplet<double>>> tripletsByWorker(static_cast<std::size_t>(parallelWorkerCount));
	const std::size_t elementsPerWorker =
		(preparedElements.size() + static_cast<std::size_t>(parallelWorkerCount) - 1) /
		static_cast<std::size_t>(parallelWorkerCount);
	for (auto& workerTriplets : tripletsByWorker)
	{
		workerTriplets.reserve(elementsPerWorker * 36);
	}
	vector<Triplet<double>> KTriplets;

	// 固定尺寸 Ke 可由不同线程独立计算，不共享可写状态。
	fem::GpuElementBackend gpuBackend(preparedElements.size(),
		ReadEnvironmentVariable("FEM_COMPUTE"), ReadEnvironmentVariable("FEM_GPU_DEVICE"),
		ReadEnvironmentVariable("FEM_GPU_MIN_ELEMENTS"));
	vector<fem::GpuElementInput> gpuInputs;
	if (gpuBackend.Available())
	{
		gpuInputs.reserve(preparedElements.size());
		for (std::size_t i = 0; i < preparedElements.size(); ++i)
		{
			const auto& element = calculationModel.elements[i];
			gpuInputs.push_back({ preparedElements[i].coordinates,
				element.poissonRatio, element.elasticModulus, element.area });
		}
	}
	const bool gpuStiffness = gpuBackend.Stiffness(gpuInputs, elementStiffnessMatrices);
	statusOutput << "Element compute backend: " << gpuBackend.Status() << '\n';
	if (!gpuStiffness)
	{
#ifdef _OPENMP
#pragma omp parallel for schedule(static) num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
	for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
	{
		const auto index = static_cast<std::size_t>(elementIndex);
		const auto& coordinates = preparedElements[index].coordinates;
		const auto& element = calculationModel.elements[index];
		elementStiffnessMatrices[index] = fem::CalculateElementStiffness(
			coordinates[0], coordinates[1], coordinates[2], coordinates[3], coordinates[4], coordinates[5],
			element.poissonRatio, element.elasticModulus, element.area);
	}
	}

	// 每个线程只写自己的 Triplet 容器，随后按线程编号顺序合并，避免锁竞争。
#ifdef _OPENMP
#pragma omp parallel num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
	{
		int workerIndex = 0;
#ifdef _OPENMP
		workerIndex = omp_get_thread_num();
#endif
		auto& localTriplets = tripletsByWorker[static_cast<std::size_t>(workerIndex)];
#ifdef _OPENMP
#pragma omp for schedule(static)
#endif
		for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
		{
			const auto index = static_cast<std::size_t>(elementIndex);
			const auto& dofs = preparedElements[index].globalDofs;
			const auto& Ke = elementStiffnessMatrices[index];
			for (int localRow = 0; localRow < 6; ++localRow)
			{
				const int row = dofs[localRow];
				if (fixedDof[row] != 0)
				{
					continue;
				}
				for (int localColumn = 0; localColumn < 6; ++localColumn)
				{
					const int column = dofs[localColumn];
					if (fixedDof[column] == 0)
					{
						localTriplets.emplace_back(row, column, Ke(localRow, localColumn));
					}
				}
			}
		}
	}
	std::size_t assembledTripletCount = 0;
	for (const auto& workerTriplets : tripletsByWorker)
	{
		assembledTripletCount += workerTriplets.size();
	}
	KTriplets.reserve(assembledTripletCount + static_cast<std::size_t>(globalDofCount));
	for (auto& workerTriplets : tripletsByWorker)
	{
		KTriplets.insert(KTriplets.end(),
			std::make_move_iterator(workerTriplets.begin()),
			std::make_move_iterator(workerTriplets.end()));
	}

	// 对固定自由度补 K(d,d)=1，并令 F(d)=0。
	// 由于当前固定边界是零位移约束，不需要额外修正其他自由度的右端项。
	for (int dof = 0; dof < globalDofCount; dof++)
	{
		if (fixedDof[dof])
		{
			KTriplets.emplace_back(dof, dof, 1.0);
			nodeForce(dof) = 0.0;
		}
	}

	// 将 Triplet 列表压缩成真正的 Eigen 稀疏矩阵；重复的 (row, col) 会自动累加。
	K.setFromTriplets(KTriplets.begin(), KTriplets.end());
	K.makeCompressed();

	statusOutput << "Global stiffness matrix assembled: "
		<< K.rows() << " x " << K.cols()
		<< ", nonzeros = " << K.nonZeros() << '\n';


	//检查日志
		/*cout << "\n========== Sparse K nonzero entries ==========\n";
		cout << "rows = " << K.rows()
			<< ", cols = " << K.cols()
			<< ", nonzeros = " << K.nonZeros() << '\n';
		for (int outer = 0; outer < K.outerSize(); ++outer)
		{
			for (SparseMatrix<double>::InnerIterator it(K, outer); it; ++it)
			{
				cout << "K(" << it.row() << ", " << it.col() << ") = "
					<< it.value() << '\n';
			}
		}*/

		SimplicialLDLT<Eigen::SparseMatrix<double>> solver;  //定义总体刚度矩阵的求解器

		solver.analyzePattern(K);  // 分析稀疏矩阵非零结构。

		solver.factorize(K);  // 对总体刚度矩阵做数值分解。

		if (solver.info() != Success)
		{
			cerr << "总体刚度矩阵分解失败，请检查边界条件是否足够，或者总体刚度矩阵是否奇异。" << endl;
			return 1;
		}

		nodeDisplacement = solver.solve(nodeForce);  //稀疏矩阵巧乐斯基方法求解位移向量

		if (solver.info() != Success)
		{
			cerr << "位移向量求解失败。" << endl;
			return 1;
		}


		// 详细模式下输出逐节点位移；正式计算默认关闭，避免大量同步控制台 I/O。
		if (verboseOutput)
		{
			for (const auto& node : calculationModel.nodes)
			{
				const auto& nodeIndex = nodeIndexByNo.at(node.nodeNo);

				statusOutput << "node " << node.nodeNo
					<< ": ux = " << nodeDisplacement(nodeIndex.dofUx)
					<< ", uy = " << nodeDisplacement(nodeIndex.dofUy)
					<< '\n';
			}
		}

		vector<Matrix2d> Strain(calculationModel.elements.size(), Matrix2d::Zero());
		vector<Matrix2d> Stress(calculationModel.elements.size(), Matrix2d::Zero());
		vector<fem::ElementDisplacementVector> elementDisplacements(preparedElements.size());
		vector<fem::StrainStressMatrix> elementStrainStress(preparedElements.size());

		// 使用预计算的六个全局自由度提取各单元位移，无需再次查询 unordered_map。
#ifdef _OPENMP
#pragma omp parallel for schedule(static) num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
		for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
		{
			const auto index = static_cast<std::size_t>(elementIndex);
			const auto& dofs = preparedElements[index].globalDofs;
			for (int localDof = 0; localDof < 6; ++localDof)
			{
				elementDisplacements[index](localDof) = nodeDisplacement(dofs[localDof]);
			}
		}

		const bool gpuStress = gpuBackend.StrainStress(gpuInputs, elementDisplacements, elementStrainStress);
		statusOutput << "Element strain/stress backend: "
			<< (gpuStress ? "OpenCL GPU FP64" : "CPU Eigen/OpenMP") << '\n';
		if (!gpuStress)
		{
#ifdef _OPENMP
#pragma omp parallel for schedule(static) num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
		for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
		{
			const auto index = static_cast<std::size_t>(elementIndex);
			const auto& coordinates = preparedElements[index].coordinates;
			const auto& element = calculationModel.elements[index];
			elementStrainStress[index] = fem::CalculateElementStrainStress(
				coordinates[0], coordinates[1], coordinates[2], coordinates[3], coordinates[4], coordinates[5],
				element.poissonRatio, element.elasticModulus, element.area, elementDisplacements[index]);
		}
		}

#ifdef _OPENMP
#pragma omp parallel for schedule(static) num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
		for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
		{
			const auto index = static_cast<std::size_t>(elementIndex);
			const int resultIndex = preparedElements[index].resultIndex;
			const auto& strainStress = elementStrainStress[index];
			Strain[resultIndex] = strainStress.block<2, 2>(0, 0);
			Stress[resultIndex] = strainStress.block<2, 2>(0, 2);
		}

		if (verboseOutput)
		{
			statusOutput << "\n========== ELEMENT STRAIN AND STRESS TENSORS ==========\n";
			for (const auto& element : calculationModel.elements)
			{
				const int resultIndex = element.elementNo - 1;
				if (resultIndex < 0 || resultIndex >= static_cast<int>(Strain.size()))
				{
					cerr << "Element " << element.elementNo << " has invalid result index." << endl;
					continue;
				}

				//// 当前三节点常应变三角形单元内部应变、应力为常量，因此每个单元打印一个张量。
				//cout << "Element " << element.elementNo
				//	<< " centroid=(" << element.centroidX << ", " << element.centroidY << ")\n";
				//cout << "  Strain tensor:\n";
				//cout << "    [" << Strain[resultIndex](0, 0) << ", " << Strain[resultIndex](0, 1) << "]\n";
				//cout << "    [" << Strain[resultIndex](1, 0) << ", " << Strain[resultIndex](1, 1) << "]\n";
				//cout << "  Stress tensor:\n";
				//cout << "    [" << Stress[resultIndex](0, 0) << ", " << Stress[resultIndex](0, 1) << "]\n";
				//cout << "    [" << Stress[resultIndex](1, 0) << ", " << Stress[resultIndex](1, 1) << "]\n";
			}
		}

		//安全检查

		VectorXi securityCheckList(static_cast<int>(calculationModel.elements.size()));
		securityCheckList.setZero();  // 正常、超过抗压强度、超过抗拉强度、超过屈服强度：0、1、2、3
#ifdef _OPENMP
#pragma omp parallel for schedule(static) num_threads(parallelWorkerCount) if(parallelWorkerCount > 1)
#endif
		for (long long elementIndex = 0; elementIndex < static_cast<long long>(preparedElements.size()); ++elementIndex)
		{
			const auto index = static_cast<std::size_t>(elementIndex);
			const auto& element = calculationModel.elements[index];
			const int resultIndex = preparedElements[index].resultIndex;
			securityCheckList(resultIndex) = fem::CheckElementSecurity(
				element.yieldStrength,
				element.tensileStrength,
				element.compressiveStrength,
				Stress[resultIndex]);
		}

		//cout << "\n\n";
		//cout << securityCheckList;

		if (writeTextFiles)
		{
			try
			{
				const auto resultPath = fem::ExportCalculationResults(
					calculationModel,
					nodeDisplacement,
					Strain,
					Stress,
					securityCheckList);
				statusOutput << "Calculation results exported to: " << resultPath.u8string() << '\n';
			}
			catch (const std::exception& error)
			{
				cerr << "Failed to export calculation results: " << error.what() << endl;
				return 1;
			}
		}

		if (binaryIpc)
		{
			try
			{
				fem::WriteCalculationResultBinary(
					std::cout, calculationModel, nodeDisplacement, Strain, Stress, securityCheckList);
			}
			catch (const std::exception& error)
			{
				cerr << "Failed to write binary calculation result: " << error.what() << '\n';
				return 1;
			}
		}

	return 0;
}

