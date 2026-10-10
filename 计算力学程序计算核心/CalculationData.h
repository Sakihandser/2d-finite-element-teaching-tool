#pragma once

#include <filesystem>
#include <iosfwd>
#include <string>
#include <vector>

namespace fem {

// 材料数据：从输入文件 MATERIALS 段读取，供单元刚度矩阵计算和后处理使用。
struct MaterialData {
  int materialNo = 0;
  double elasticModulus = 0.0;
  double poissonRatio = 0.0;
  double density = 0.0;
  double yieldStrength = 0.0;
  double tensileStrength = 0.0;
  double compressiveStrength = 0.0;
};

// 计算节点数据：包含节点坐标、约束状态、自由度编号、节点外力和所属材料/区域。
struct NodeData {
  int nodeNo = 0;
  double x = 0.0;
  double y = 0.0;
  bool fixUx = false;
  bool fixUy = false;
  int dofUx = 0;
  int dofUy = 0;
  double forceX = 0.0;
  double forceY = 0.0;
  int materialNo = 0;
  int regionNo = 0;
};

// 三节点三角形单元数据：包含连接节点、面积、质心和该单元使用的材料参数。
struct ElementData {
  int elementNo = 0;
  int node1 = 0;
  int node2 = 0;
  int node3 = 0;
  double area = 0.0;
  double centroidX = 0.0;
  double centroidY = 0.0;
  int materialNo = 0;
  double elasticModulus = 0.0;
  double poissonRatio = 0.0;
  double density = 0.0;
  double yieldStrength = 0.0;
  double tensileStrength = 0.0;
  double compressiveStrength = 0.0;
};

// 单元等效节点载荷：一个三角形单元有三个节点，每个节点有 Fx/Fy 两个等效力分量。
struct ElementNodeLoadData {
  int elementNo = 0;
  double forceX1 = 0.0;
  double forceY1 = 0.0;
  double forceX2 = 0.0;
  double forceY2 = 0.0;
  double forceX3 = 0.0;
  double forceY3 = 0.0;
};

// 输入文件中的单位声明。当前只记录文本，不在 C++ 端自动做单位换算。
struct UnitData {
  std::string length;
  std::string force;
  std::string elasticModulus;
  std::string density;
  std::string strength;
};

// 输入文件头部的数量统计，用于导入后和实际解析数量进行校验。
struct CountData {
  int nodes = 0;
  int elements = 0;
  int materials = 0;
  int pointLoads = 0;
  int distributedLoads = 0;
  int bodyLoads = 0;
};

// 完整计算模型：保存一个输入文件中和有限元求解相关的全部数据。
struct CalculationModel {
  std::filesystem::path sourcePath;
  std::string header;
  std::string modelName;
  std::string generatedAt;
  UnitData units;
  CountData counts;
  std::vector<MaterialData> materials;
  std::vector<NodeData> nodes;
  std::vector<ElementData> elements;
  std::vector<ElementNodeLoadData> elementNodeLoads;
  std::vector<std::string> fileWarnings;
  std::vector<std::string> parserWarnings;
};

// 从当前工作目录向上查找默认输入文件 calculation-data/calculation-input.txt。
std::filesystem::path FindDefaultCalculationInputPath();

// 读取并解析计算输入文件，返回结构化 CalculationModel。
CalculationModel LoadCalculationInput(const std::filesystem::path& inputPath);

// 校验已经构造好的模型；文本导入和 Node.js 二进制管道共用同一套一致性检查。
void ValidateCalculationModel(CalculationModel& model);

// 打印导入后的模型内容，主要用于调试和检查前端导出是否正确。
void PrintCalculationModel(const CalculationModel& model, std::ostream& output);

}  // namespace fem
