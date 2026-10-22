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
#include "BlastDynamics.h"
#include "CalculationBinaryIO.h"
#include "CalculationResultExport.h"
#include "ElementCalculations.h"
#include "GpuElementBackend.h"
#include "PerformanceLog.h"

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
	fem::PerformanceLog performanceLog;
	const bool verboseOutput = IsVerboseOutputEnabled(argc, argv);
	const bool binaryIpc = HasCommandLineArgument(argc, argv, "--binary-ipc");
	const bool writeTextFiles = !binaryIpc || HasCommandLineArgument(argc, argv, "--write-text");
	std::ostream& statusOutput = binaryIpc ? std::cerr : std::cout;
	performanceLog.SetDetail("详细控制台输出", verboseOutput ? "启用" : "关闭");
	performanceLog.SetDetail("模型传输方式", binaryIpc ? "Node.js/C++ 二进制管道" : "TXT 文件");
	performanceLog.SetDetail("计算输入/结果 TXT", writeTextFiles ? "生成" : "不生成");
	performanceLog.SetDetail("构建类型",
#ifdef NDEBUG
		"Release"
#else
		"Debug"
#endif
	);
	performanceLog.SetDetail("程序位数", std::to_string(sizeof(void*) * 8) + " bit");
	performanceLog.SetDetail("Eigen 版本",
		std::to_string(EIGEN_WORLD_VERSION) + "." +
		std::to_string(EIGEN_MAJOR_VERSION) + "." +
		std::to_string(EIGEN_MINOR_VERSION));
	performanceLog.SetDetail("硬件并发线程数", std::to_string(std::thread::hardware_concurrency()));
#ifdef _MSC_VER
	performanceLog.SetDetail("编译器", "MSVC " + std::to_string(_MSC_VER));
#elif defined(__GNUC__)
	performanceLog.SetDetail("编译器", "GCC " + std::to_string(__GNUC__) + "." + std::to_string(__GNUC_MINOR__));
#else
	performanceLog.SetDetail("编译器", "未知");
#endif

	fem::CalculationModel calculationModel;
	std::filesystem::path inputPath;
	auto currentStageStartedAt = fem::PerformanceLog::Now();
	std::string currentStageName = binaryIpc ? "01.1 初始化二进制管道" : "01.1 查找输入文件";

	try
	{
		if (binaryIpc)
		{
			fem::ConfigureBinaryStandardStreams();
			performanceLog.AddTiming(currentStageName, currentStageStartedAt);
			currentStageName = "01.2 从 Node.js 二进制管道读取模型";
			currentStageStartedAt = fem::PerformanceLog::Now();
			calculationModel = fem::LoadCalculationModelBinary(std::cin);
			if (HasCommandLineArgument(argc, argv, "--blast-ipc"))
			{
				const int result = fem::RunBlastDynamics(calculationModel, argc, argv, std::cout);
				performanceLog.MarkSuccess();
				return result;
			}
			if (writeTextFiles)
			{
				inputPath = fem::FindDefaultCalculationInputPath();
				calculationModel.sourcePath = inputPath;
				performanceLog.SetLogRootHint(inputPath);
			}
		}
		else
		{
			// 兼容直接运行 exe：继续从 calculation-data/calculation-input.txt 导入。
			inputPath = fem::FindDefaultCalculationInputPath();
			performanceLog.AddTiming(currentStageName, currentStageStartedAt);
			performanceLog.SetLogRootHint(inputPath);
			currentStageName = "01.2 读取并解析输入文件";
			currentStageStartedAt = fem::PerformanceLog::Now();
			calculationModel = fem::LoadCalculationInput(inputPath);
		}
		performanceLog.AddTiming(currentStageName, currentStageStartedAt);
		performanceLog.SetDetail("模型名称", calculationModel.modelName);
		performanceLog.SetDetail("输入文件", binaryIpc && !writeTextFiles
			? "未生成（Node.js 二进制管道）"
			: calculationModel.sourcePath.u8string());
		performanceLog.SetDetail("模型生成时间", calculationModel.generatedAt);
		performanceLog.SetDetail("节点数（实际/声明）",
			std::to_string(calculationModel.nodes.size()) + " / " + std::to_string(calculationModel.counts.nodes));
		performanceLog.SetDetail("单元数（实际/声明）",
			std::to_string(calculationModel.elements.size()) + " / " + std::to_string(calculationModel.counts.elements));
		performanceLog.SetDetail("材料数（实际/声明）",
			std::to_string(calculationModel.materials.size()) + " / " + std::to_string(calculationModel.counts.materials));
		performanceLog.SetDetail("单元等效节点载荷行数", std::to_string(calculationModel.elementNodeLoads.size()));
		performanceLog.SetDetail("载荷声明（点/分布/体）",
			std::to_string(calculationModel.counts.pointLoads) + " / " +
			std::to_string(calculationModel.counts.distributedLoads) + " / " +
			std::to_string(calculationModel.counts.bodyLoads));
		performanceLog.SetDetail("输入警告数（文件/解析器）",
			std::to_string(calculationModel.fileWarnings.size()) + " / " +
			std::to_string(calculationModel.parserWarnings.size()));

		// 打印导入结果，方便检查节点、单元、材料、载荷和警告信息是否正确。
		currentStageName = "01.3 输入模型控制台输出";
		if (verboseOutput)
		{
			currentStageStartedAt = fem::PerformanceLog::Now();
			fem::PrintCalculationModel(calculationModel, statusOutput);
			performanceLog.AddTiming(currentStageName, currentStageStartedAt);
		}
		else
		{
			performanceLog.AddDuration(currentStageName, fem::PerformanceLog::Duration::zero(), 0);
		}
	}
	catch (const std::exception& error)
	{
		performanceLog.AddTiming(currentStageName + "（失败）", currentStageStartedAt);
		performanceLog.MarkFailure(std::string("导入计算输入失败: ") + error.what());
		std::cerr << (HasCommandLineArgument(argc, argv, "--blast-ipc") ? "Blast simulation failed: " : "Failed to import calculation input: ") << error.what() << '\n';
		return 1;
	}





	currentStageStartedAt = fem::PerformanceLog::Now();
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
			performanceLog.MarkFailure("节点自由度编号无效: node " + std::to_string(node.nodeNo));
			cerr << "Node " << node.nodeNo << " has invalid dof number." << '\n';
			return 1;
		}

		const NodeIndexData nodeIndex = { i, node.dofUx - 1, node.dofUy - 1 };
		if (!nodeIndexByNo.emplace(node.nodeNo, nodeIndex).second)
		{
			performanceLog.MarkFailure("节点编号重复: node " + std::to_string(node.nodeNo));
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
	performanceLog.AddTiming("02.1 建立节点坐标与自由度索引", currentStageStartedAt);
	performanceLog.SetDetail("总体自由度数", std::to_string(globalDofCount));

	currentStageStartedAt = fem::PerformanceLog::Now();
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
			performanceLog.MarkFailure("初始化载荷时找不到节点: node " + std::to_string(node.nodeNo));
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
	performanceLog.AddTiming("02.2 初始化位移、载荷与边界条件", currentStageStartedAt);
	const auto fixedDofCount = static_cast<std::size_t>(std::count(fixedDof.begin(), fixedDof.end(), 1));
	std::size_t loadedDofCount = 0;
	for (Eigen::Index dof = 0; dof < nodeForce.size(); ++dof)
	{
		if (nodeForce(dof) != 0.0)
		{
			++loadedDofCount;
		}
	}
	performanceLog.SetDetail("固定自由度数", std::to_string(fixedDofCount));
	performanceLog.SetDetail("非零载荷自由度数", std::to_string(loadedDofCount));

	// 单元连接关系、坐标和全局自由度只解析一次，供刚度装配与后处理共同复用。
	struct PreparedElementData
	{
		array<double, 6> coordinates{};
		array<int, 6> globalDofs{};
		int resultIndex = -1;
	};

	currentStageStartedAt = fem::PerformanceLog::Now();
	vector<PreparedElementData> preparedElements(calculationModel.elements.size());
	vector<bool> usedResultSlots(calculationModel.elements.size(), false);
	for (std::size_t elementIndex = 0; elementIndex < calculationModel.elements.size(); ++elementIndex)
	{
		const auto& element = calculationModel.elements[elementIndex];
		if (element.area <= 0.0)
		{
			performanceLog.MarkFailure("单元面积非正: element " + std::to_string(element.elementNo));
			cerr << "Element " << element.elementNo << " has non-positive area: " << element.area << '\n';
			return 1;
		}

		const int resultIndex = element.elementNo - 1;
		if (resultIndex < 0 || resultIndex >= static_cast<int>(calculationModel.elements.size()) || usedResultSlots[resultIndex])
		{
			performanceLog.MarkFailure("单元编号无效或重复: element " + std::to_string(element.elementNo));
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
				performanceLog.MarkFailure("单元引用缺失节点: element " + std::to_string(element.elementNo));
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
	const auto elementCallCount = static_cast<std::uint64_t>(preparedElements.size());
	performanceLog.AddTiming("02.3 预计算单元连接、坐标与自由度", currentStageStartedAt, elementCallCount);
	const int parallelWorkerCount = DetermineParallelWorkerCount(preparedElements.size());
	performanceLog.SetDetail("单元并行线程数", std::to_string(parallelWorkerCount));
#ifdef _OPENMP
	performanceLog.SetDetail("OpenMP", "启用");
#else
	performanceLog.SetDetail("OpenMP", "未启用（串行回退）");
#endif

	currentStageStartedAt = fem::PerformanceLog::Now();
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
	performanceLog.AddTiming("03.1 刚度矩阵装配准备", currentStageStartedAt);

	// 固定尺寸 Ke 可由不同线程独立计算，不共享可写状态。
	currentStageStartedAt = fem::PerformanceLog::Now();
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
	performanceLog.AddTiming("03.2 GPU 检测、初始化与输入准备", currentStageStartedAt);
	currentStageStartedAt = fem::PerformanceLog::Now();
	const bool gpuStiffness = gpuBackend.Stiffness(gpuInputs, elementStiffnessMatrices);
	performanceLog.SetDetail("单元刚度计算后端", gpuStiffness ? "OpenCL GPU FP64" : "CPU Eigen/OpenMP");
	performanceLog.SetDetail("GPU 状态", gpuBackend.Status());
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
	performanceLog.AddTiming("03.3 单元刚度矩阵 Ke 计算", currentStageStartedAt, elementCallCount);

	// 每个线程只写自己的 Triplet 容器，随后按线程编号顺序合并，避免锁竞争。
	currentStageStartedAt = fem::PerformanceLog::Now();
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
	performanceLog.AddTiming("03.4 单元刚度 Triplet 并行装配与合并", currentStageStartedAt, elementCallCount);

	currentStageStartedAt = fem::PerformanceLog::Now();
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
	performanceLog.AddTiming("03.6 施加固定边界条件", currentStageStartedAt);
	performanceLog.SetDetail("Triplet 条目数（合并前）", std::to_string(KTriplets.size()));

	currentStageStartedAt = fem::PerformanceLog::Now();
	// 将 Triplet 列表压缩成真正的 Eigen 稀疏矩阵；重复的 (row, col) 会自动累加。
	K.setFromTriplets(KTriplets.begin(), KTriplets.end());
	K.makeCompressed();
	performanceLog.AddTiming("03.7 生成并压缩总体稀疏矩阵", currentStageStartedAt);
	performanceLog.SetDetail("总体刚度矩阵维度",
		std::to_string(K.rows()) + " x " + std::to_string(K.cols()));
	performanceLog.SetDetail("总体刚度矩阵非零元", std::to_string(K.nonZeros()));
	std::ostringstream matrixDensity;
	const double matrixEntryCount = static_cast<double>(K.rows()) * static_cast<double>(K.cols());
	matrixDensity << std::fixed << std::setprecision(6)
		<< (matrixEntryCount > 0.0 ? static_cast<double>(K.nonZeros()) * 100.0 / matrixEntryCount : 0.0)
		<< "%";
	performanceLog.SetDetail("总体刚度矩阵密度", matrixDensity.str());

	currentStageStartedAt = fem::PerformanceLog::Now();
	statusOutput << "Global stiffness matrix assembled: "
		<< K.rows() << " x " << K.cols()
		<< ", nonzeros = " << K.nonZeros() << '\n';
	performanceLog.AddTiming("03.8 刚度矩阵摘要控制台输出", currentStageStartedAt);


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
		performanceLog.SetDetail("线性求解器", "Eigen::SimplicialLDLT<SparseMatrix<double>>");

		currentStageStartedAt = fem::PerformanceLog::Now();
		solver.analyzePattern(K);  // 分析稀疏矩阵非零结构。
		performanceLog.AddTiming("04.1 LDLT 稀疏结构分析", currentStageStartedAt);

		currentStageStartedAt = fem::PerformanceLog::Now();
		solver.factorize(K);  // 对总体刚度矩阵做数值分解。
		performanceLog.AddTiming("04.2 LDLT 数值分解", currentStageStartedAt);

		if (solver.info() != Success)
		{
			performanceLog.MarkFailure("总体刚度矩阵 LDLT 分解失败");
			cerr << "总体刚度矩阵分解失败，请检查边界条件是否足够，或者总体刚度矩阵是否奇异。" << endl;
			return 1;
		}

		currentStageStartedAt = fem::PerformanceLog::Now();
		nodeDisplacement = solver.solve(nodeForce);  //稀疏矩阵巧乐斯基方法求解位移向量
		performanceLog.AddTiming("04.3 线性方程回代求解", currentStageStartedAt);

		if (solver.info() != Success)
		{
			performanceLog.MarkFailure("位移向量回代求解失败");
			cerr << "位移向量求解失败。" << endl;
			return 1;
		}


		// 详细模式下输出逐节点位移；正式计算默认关闭，避免大量同步控制台 I/O。
		if (verboseOutput)
		{
			currentStageStartedAt = fem::PerformanceLog::Now();
			for (const auto& node : calculationModel.nodes)
			{
				const auto& nodeIndex = nodeIndexByNo.at(node.nodeNo);

				statusOutput << "node " << node.nodeNo
					<< ": ux = " << nodeDisplacement(nodeIndex.dofUx)
					<< ", uy = " << nodeDisplacement(nodeIndex.dofUy)
					<< '\n';
			}
			performanceLog.AddTiming("05 节点位移控制台输出", currentStageStartedAt,
				static_cast<std::uint64_t>(calculationModel.nodes.size()));
		}
		else
		{
			performanceLog.AddDuration("05 节点位移控制台输出", fem::PerformanceLog::Duration::zero(), 0);
		}

		currentStageStartedAt = fem::PerformanceLog::Now();
		vector<Matrix2d> Strain(calculationModel.elements.size(), Matrix2d::Zero());
		vector<Matrix2d> Stress(calculationModel.elements.size(), Matrix2d::Zero());
		vector<fem::ElementDisplacementVector> elementDisplacements(preparedElements.size());
		vector<fem::StrainStressMatrix> elementStrainStress(preparedElements.size());
		performanceLog.AddTiming("06.1 应变应力结果数组初始化", currentStageStartedAt);

		// 使用预计算的六个全局自由度提取各单元位移，无需再次查询 unordered_map。
		currentStageStartedAt = fem::PerformanceLog::Now();
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
		performanceLog.AddTiming("06.2 从预计算自由度提取单元位移", currentStageStartedAt, elementCallCount);

		currentStageStartedAt = fem::PerformanceLog::Now();
		const bool gpuStress = gpuBackend.StrainStress(gpuInputs, elementDisplacements, elementStrainStress);
		performanceLog.SetDetail("应变应力计算后端", gpuStress ? "OpenCL GPU FP64" : "CPU Eigen/OpenMP");
		performanceLog.SetDetail("GPU 状态", gpuBackend.Status());
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
		performanceLog.AddTiming("06.3 单元应变应力并行计算", currentStageStartedAt, elementCallCount);

		currentStageStartedAt = fem::PerformanceLog::Now();
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
		performanceLog.AddTiming("06.4 应变应力结果并行写入", currentStageStartedAt, elementCallCount);

		if (verboseOutput)
		{
			currentStageStartedAt = fem::PerformanceLog::Now();
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
			performanceLog.AddTiming("06.6 应变应力结果索引检查与控制台标题", currentStageStartedAt,
				elementCallCount);
		}
		else
		{
			performanceLog.AddDuration("06.6 应变应力结果索引检查与控制台标题",
				fem::PerformanceLog::Duration::zero(), 0);
		}

		//安全检查

		currentStageStartedAt = fem::PerformanceLog::Now();
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
		performanceLog.AddTiming("07 单元强度安全校核", currentStageStartedAt, elementCallCount);

		//cout << "\n\n";
		//cout << securityCheckList;

		if (writeTextFiles)
		{
			currentStageStartedAt = fem::PerformanceLog::Now();
			try
			{
				const auto resultPath = fem::ExportCalculationResults(
					calculationModel,
					nodeDisplacement,
					Strain,
					Stress,
					securityCheckList);
				performanceLog.AddTiming("08 计算结果 TXT 导出", currentStageStartedAt);
				performanceLog.SetDetail("结果文件", resultPath.u8string());
				statusOutput << "Calculation results exported to: " << resultPath.u8string() << '\n';
			}
			catch (const std::exception& error)
			{
				performanceLog.AddTiming("08 计算结果 TXT 导出（失败）", currentStageStartedAt);
				performanceLog.MarkFailure(std::string("导出计算结果失败: ") + error.what());
				cerr << "Failed to export calculation results: " << error.what() << endl;
				return 1;
			}
		}
		else
		{
			performanceLog.AddDuration("08 计算结果 TXT 导出", fem::PerformanceLog::Duration::zero(), 0);
			performanceLog.SetDetail("结果文件", "未生成（结果经二进制管道返回）");
		}

		if (binaryIpc)
		{
			currentStageStartedAt = fem::PerformanceLog::Now();
			try
			{
				fem::WriteCalculationResultBinary(
					std::cout, calculationModel, nodeDisplacement, Strain, Stress, securityCheckList);
				performanceLog.AddTiming("09 向 Node.js 二进制管道返回结果", currentStageStartedAt);
			}
			catch (const std::exception& error)
			{
				performanceLog.AddTiming("09 向 Node.js 二进制管道返回结果（失败）", currentStageStartedAt);
				performanceLog.MarkFailure(std::string("二进制结果传输失败: ") + error.what());
				cerr << "Failed to write binary calculation result: " << error.what() << '\n';
				return 1;
			}
		}

	performanceLog.MarkSuccess();
	try
	{
		const auto performanceLogPath = performanceLog.Write();
		statusOutput << "Performance log written to: " << performanceLogPath.u8string() << '\n';
	}
	catch (const std::exception& error)
	{
		cerr << "Failed to write performance log: " << error.what() << endl;
		return 1;
	}

	return 0;
}

