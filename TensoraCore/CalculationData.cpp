#include "CalculationData.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <type_traits>
#include <unordered_set>
#include <unordered_map>
#include <limits>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fem {
namespace {

// 输入文件固定格式标记和默认路径。文件头不匹配时，说明不是当前版本导出的计算文件。
constexpr const char* kExpectedHeader = "FEM_CALCULATION_INPUT_TXT_V1";
constexpr const char* kDataDirectory = "calculation-data";
constexpr const char* kInputFilename = "calculation-input.txt";

// 当前解析器支持的段落。读到段落名后，后续数据行会按该段格式解析。
enum class Section {
  none,
  materials,
  nodes,
  elements,
  elementNodeLoads,
  warnings,
};

// 去掉字符串首尾空白，便于解析行关键字和数据字段。
std::string Trim(const std::string& value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  });
  if (first == value.end()) {
    return "";
  }
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char ch) {
    return std::isspace(ch) != 0;
  }).base();
  return std::string(first, last);
}

// 返回原字符串中的去空白视图，避免为每一条节点、单元数据额外分配字符串。
std::string_view TrimView(std::string_view value) {
  std::size_t first = 0;
  while (first < value.size() && std::isspace(static_cast<unsigned char>(value[first])) != 0) {
    ++first;
  }
  std::size_t last = value.size();
  while (last > first && std::isspace(static_cast<unsigned char>(value[last - 1])) != 0) {
    --last;
  }
  return value.substr(first, last - first);
}

// 去掉 UTF-8 BOM，避免第一行文件头因为隐藏字节匹配失败。
std::string_view RemoveUtf8Bom(std::string_view value) {
  if (value.size() >= 3 &&
      static_cast<unsigned char>(value[0]) == 0xEF &&
      static_cast<unsigned char>(value[1]) == 0xBB &&
      static_cast<unsigned char>(value[2]) == 0xBF) {
    value.remove_prefix(3);
  }
  return value;
}

// 将字符串转换为大写，用于大小写不敏感地识别段落名和关键字。
std::string ToUpper(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return value;
}

// 判断字符串是否以指定前缀开头。
bool StartsWith(std::string_view value, std::string_view prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

// 输入文件中以 # 开头的行视为注释。
bool IsComment(std::string_view line) {
  return !line.empty() && line[0] == '#';
}

bool EqualsIgnoreCase(std::string_view value, std::string_view expected) {
  if (value.size() != expected.size()) {
    return false;
  }
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (std::toupper(static_cast<unsigned char>(value[i])) !=
        std::toupper(static_cast<unsigned char>(expected[i]))) {
      return false;
    }
  }
  return true;
}

// 判断当前行是否是段落头，并更新解析状态。
bool ParseSectionHeader(std::string_view line, Section& section) {
  // 数值数据行占绝大多数；先看首字符，避免为每一行复制并大写整行。
  if (line.empty() || std::isalpha(static_cast<unsigned char>(line.front())) == 0) {
    return false;
  }
  const std::string name = ToUpper(std::string(line));
  if (name == "MATERIALS") {
    section = Section::materials;
    return true;
  }
  if (name == "NODES") {
    section = Section::nodes;
    return true;
  }
  if (name == "ELEMENTS") {
    section = Section::elements;
    return true;
  }
  if (name == "ELEMENT_NODE_LOADS") {
    section = Section::elementNodeLoads;
    return true;
  }
  if (name == "WARNINGS") {
    section = Section::warnings;
    return true;
  }
  return false;
}

// 取得关键字后的内容，例如 "MODEL xxx" -> "xxx"。
std::string AfterKeyword(std::string_view line, std::string_view keyword) {
  return Trim(std::string(line.substr(keyword.size())));
}

// 解析一个单位键值，例如 LENGTH=model 或 FORCE=N。
void ParseUnitToken(const std::string& token, UnitData& units) {
  const auto equalPos = token.find('=');
  if (equalPos == std::string::npos) {
    return;
  }
  const std::string key = ToUpper(token.substr(0, equalPos));
  const std::string value = token.substr(equalPos + 1);
  if (key == "LENGTH") {
    units.length = value;
  } else if (key == "FORCE") {
    units.force = value;
  } else if (key == "ELASTIC_MODULUS") {
    units.elasticModulus = value;
  } else if (key == "DENSITY") {
    units.density = value;
  } else if (key == "STRENGTH") {
    units.strength = value;
  }
}

// 解析 UNITS 行，把不同物理量的单位文本保存到 UnitData 中。
void ParseUnitsLine(std::string_view line, UnitData& units) {
  std::istringstream stream(AfterKeyword(line, "UNITS"));
  std::string token;
  while (stream >> token) {
    ParseUnitToken(token, units);
  }
}

// 解析一个数量键值，例如 NODES=45 或 ELEMENTS=64。
void ParseCountToken(const std::string& token, CountData& counts) {
  const auto equalPos = token.find('=');
  if (equalPos == std::string::npos) {
    return;
  }
  const std::string key = ToUpper(token.substr(0, equalPos));
  const int value = std::stoi(token.substr(equalPos + 1));
  if (key == "NODES") {
    counts.nodes = value;
  } else if (key == "ELEMENTS") {
    counts.elements = value;
  } else if (key == "MATERIALS") {
    counts.materials = value;
  } else if (key == "POINT_LOADS") {
    counts.pointLoads = value;
  } else if (key == "DISTRIBUTED_LOADS") {
    counts.distributedLoads = value;
  } else if (key == "BODY_LOADS") {
    counts.bodyLoads = value;
  }
}

// 解析 COUNTS 行，用于后续校验实际读取数量。
void ParseCountsLine(std::string_view line, CountData& counts) {
  std::istringstream stream(AfterKeyword(line, "COUNTS"));
  std::string token;
  while (stream >> token) {
    ParseCountToken(token, counts);
  }
}

// 面向固定数值列的无分配扫描器。相比为每一行构造 istringstream，from_chars
// 直接在原始行缓冲区上完成转换，特别适合节点、单元和载荷的大批量数据。
class NumericLineScanner {
 public:
  explicit NumericLineScanner(std::string_view line)
      : cursor_(line.data()), end_(line.data() + line.size()) {}

  bool Read(int& value) {
    SkipWhitespace();
    const auto result = std::from_chars(cursor_, end_, value);
    if (result.ec != std::errc{} || result.ptr == cursor_) {
      return false;
    }
    cursor_ = result.ptr;
    return true;
  }

  bool Read(double& value) {
    SkipWhitespace();
    const auto result = std::from_chars(cursor_, end_, value, std::chars_format::general);
    if (result.ec != std::errc{} || result.ptr == cursor_) {
      return false;
    }
    cursor_ = result.ptr;
    return true;
  }

 private:
  void SkipWhitespace() {
    while (cursor_ != end_ && std::isspace(static_cast<unsigned char>(*cursor_)) != 0) {
      ++cursor_;
    }
  }

  const char* cursor_;
  const char* end_;
};

// 通用数据行解析函数。
// 根据模板类型 T 的不同，分别按材料、节点、单元或单元等效节点载荷的列格式读取。
template <typename T>
T ParseDataLine(std::string_view line, int lineNumber, std::string_view sectionName) {
  T value{};
  NumericLineScanner scanner(line);
  bool parsed = false;
  if constexpr (std::is_same_v<T, MaterialData>) {
    parsed = scanner.Read(value.materialNo) && scanner.Read(value.elasticModulus) &&
             scanner.Read(value.poissonRatio) && scanner.Read(value.density) &&
             scanner.Read(value.yieldStrength) && scanner.Read(value.tensileStrength) &&
             scanner.Read(value.compressiveStrength);
  } else if constexpr (std::is_same_v<T, NodeData>) {
    int fixUx = 0;
    int fixUy = 0;
    parsed = scanner.Read(value.nodeNo) && scanner.Read(value.x) && scanner.Read(value.y) &&
             scanner.Read(fixUx) && scanner.Read(fixUy) && scanner.Read(value.dofUx) &&
             scanner.Read(value.dofUy) && scanner.Read(value.forceX) && scanner.Read(value.forceY) &&
             scanner.Read(value.materialNo) && scanner.Read(value.regionNo);
    value.fixUx = fixUx != 0;
    value.fixUy = fixUy != 0;
  } else if constexpr (std::is_same_v<T, ElementData>) {
    parsed = scanner.Read(value.elementNo) && scanner.Read(value.node1) && scanner.Read(value.node2) &&
             scanner.Read(value.node3) && scanner.Read(value.area) && scanner.Read(value.centroidX) &&
             scanner.Read(value.centroidY) && scanner.Read(value.materialNo) &&
             scanner.Read(value.elasticModulus) && scanner.Read(value.poissonRatio) &&
             scanner.Read(value.density) && scanner.Read(value.yieldStrength) &&
             scanner.Read(value.tensileStrength) && scanner.Read(value.compressiveStrength);
  } else if constexpr (std::is_same_v<T, ElementNodeLoadData>) {
    parsed = scanner.Read(value.elementNo) && scanner.Read(value.forceX1) && scanner.Read(value.forceY1) &&
             scanner.Read(value.forceX2) && scanner.Read(value.forceY2) && scanner.Read(value.forceX3) &&
             scanner.Read(value.forceY3);
  }
  if (!parsed) {
    std::ostringstream message;
    message << "Line " << lineNumber << " cannot be parsed in section " << std::string(sectionName) << ".";
    throw std::runtime_error(message.str());
  }
  return value;
}

// 如果文件头声明的数量和实际解析数量不一致，记录警告但不中断导入。
void AddCountMismatchWarning(std::vector<std::string>& warnings, const std::string& name, int expected, std::size_t actual) {
  if (expected == static_cast<int>(actual)) {
    return;
  }
  std::ostringstream message;
  message << "COUNTS " << name << "=" << expected << ", but parsed " << actual << ".";
  warnings.push_back(message.str());
}

// 从某类数据中提取编号集合，用于检查节点/单元/材料引用是否存在。
template <typename T>
std::unordered_set<int> MakeNumberSet(const std::vector<T>& values, int T::*member) {
  std::unordered_set<int> numbers;
  numbers.reserve(values.size());
  for (const auto& value : values) {
    numbers.insert(value.*member);
  }
  return numbers;
}

// 对导入模型做一致性校验：数量是否匹配，节点/单元/载荷引用的对象是否存在。
void ValidateCalculationModelImpl(CalculationModel& model) {
  // Legacy 'model' means metres; explicit non-SI declarations are never
  // converted by this protocol and must not silently reach the solver.
  auto unit = [](const std::string& value, const char* expected, bool legacyLength=false) {
    if (!value.empty() && value != expected && !(legacyLength && value == "model"))
      throw std::runtime_error(std::string("Unsupported units: expected ") + expected + ", received " + value);
  };
  unit(model.units.length,"m",true);unit(model.units.force,"N");
  unit(model.units.elasticModulus,"Pa");unit(model.units.strength,"Pa");
  if(model.units.density!="kg/m^3")unit(model.units.density,"kg/m3");
  auto require = [](bool valid, const char* message) {if(!valid)throw std::runtime_error(message);};
  auto properties = [&](const auto& p) {
    require(std::isfinite(p.elasticModulus) && p.elasticModulus>0 && std::isfinite(p.poissonRatio) && p.poissonRatio>-1 && p.poissonRatio<.5,
      "Materials require finite positive E and -1 < nu < 0.5.");
    require(std::isfinite(p.density) && p.density>=0 && std::isfinite(p.yieldStrength) && p.yieldStrength>=0 &&
      std::isfinite(p.tensileStrength) && p.tensileStrength>=0 && std::isfinite(p.compressiveStrength) && p.compressiveStrength>=0,
      "Density and strength magnitudes must be finite and nonnegative.");
  };
  std::unordered_set<int> materialIds,elementIds,dofs;
  std::unordered_map<int,const NodeData*> nodes;
  for(const auto& m:model.materials){require(m.materialNo>0 && materialIds.insert(m.materialNo).second,"Duplicate or invalid material number.");properties(m);}
  for(const auto& n:model.nodes){
    require(n.nodeNo>0 && nodes.emplace(n.nodeNo,&n).second,"Duplicate or invalid node number.");
    require(std::isfinite(n.x) && std::isfinite(n.y) && std::isfinite(n.forceX) && std::isfinite(n.forceY),"Node coordinates and loads must be finite.");
    for(int d:{n.dofUx,n.dofUy})require(d>0 && static_cast<std::size_t>(d)<=2*model.nodes.size() && dofs.insert(d).second,"Invalid or duplicate displacement DOF.");
  }
  for(auto& e:model.elements){
    require(e.elementNo>0 && static_cast<std::size_t>(e.elementNo)<=model.elements.size() && elementIds.insert(e.elementNo).second,"Invalid or duplicate element number.");
    require(nodes.count(e.node1) && nodes.count(e.node2) && nodes.count(e.node3),"Element references a missing node.");
    properties(e);
    const auto& a=*nodes.at(e.node1);const auto& b=*nodes.at(e.node2);const auto& c=*nodes.at(e.node3);
    const double ux=b.x-a.x,uy=b.y-a.y,vx=c.x-a.x,vy=c.y-a.y,det=ux*vy-uy*vx;
    const double scale=(std::max)({ux*ux+uy*uy,vx*vx+vy*vy,(vx-ux)*(vx-ux)+(vy-uy)*(vy-uy)});
    require(std::isfinite(det) && std::isfinite(scale) && std::abs(det)>32*std::numeric_limits<double>::epsilon()*scale,"Degenerate TRI3 geometry.");
    const double area=.5*std::abs(det);
    // Old exported models rounded areas to six decimals. Accept that historic
    // quantization, then use geometry for both stiffness and strain recovery.
    require(std::isfinite(e.area) && e.area>0 && std::abs(e.area-area)<=5.1e-7+1e-6*area,"Element area disagrees with its node coordinates.");
    e.area=area;e.centroidX=(a.x+b.x+c.x)/3;e.centroidY=(a.y+b.y+c.y)/3;
  }
  for(const auto& load:model.elementNodeLoads){
    require(elementIds.count(load.elementNo)!=0,"Element load references a missing element.");
    for(double value:{load.forceX1,load.forceY1,load.forceX2,load.forceY2,load.forceX3,load.forceY3})require(std::isfinite(value),"Element loads must be finite.");
  }
  AddCountMismatchWarning(model.parserWarnings, "MATERIALS", model.counts.materials, model.materials.size());
  AddCountMismatchWarning(model.parserWarnings, "NODES", model.counts.nodes, model.nodes.size());
  AddCountMismatchWarning(model.parserWarnings, "ELEMENTS", model.counts.elements, model.elements.size());

  const auto materialNumbers = MakeNumberSet(model.materials, &MaterialData::materialNo);
  const auto nodeNumbers = MakeNumberSet(model.nodes, &NodeData::nodeNo);
  const auto elementNumbers = MakeNumberSet(model.elements, &ElementData::elementNo);

  for (const auto& node : model.nodes) {
    if (node.materialNo != 0 && materialNumbers.count(node.materialNo) == 0) {
      std::ostringstream message;
      message << "Node " << node.nodeNo << " references missing material " << node.materialNo << ".";
      model.parserWarnings.push_back(message.str());
    }
  }

  for (const auto& element : model.elements) {
    if (nodeNumbers.count(element.node1) == 0 || nodeNumbers.count(element.node2) == 0 || nodeNumbers.count(element.node3) == 0) {
      std::ostringstream message;
      message << "Element " << element.elementNo << " references missing node(s).";
      model.parserWarnings.push_back(message.str());
    }
    if (element.materialNo != 0 && materialNumbers.count(element.materialNo) == 0) {
      std::ostringstream message;
      message << "Element " << element.elementNo << " references missing material " << element.materialNo << ".";
      model.parserWarnings.push_back(message.str());
    }
  }

  for (const auto& load : model.elementNodeLoads) {
    if (elementNumbers.count(load.elementNo) == 0) {
      std::ostringstream message;
      message << "ELEMENT_NODE_LOADS references missing element " << load.elementNo << ".";
      model.parserWarnings.push_back(message.str());
    }
  }
}

// Windows 控制台默认编码可能不是 UTF-8，这里切换编码以正确显示中文模型名和路径。
void ConfigureConsoleForUtf8() {
#ifdef _WIN32
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
#endif
}

// 打印分隔标题，便于在控制台阅读不同数据段。
void PrintDivider(std::ostream& output, const std::string& title) {
  output << "\n========== " << title << " ==========\n";
}

// 打印材料表。
void PrintMaterials(const std::vector<MaterialData>& materials, std::ostream& output) {
  PrintDivider(output, "MATERIALS");
  output << "# matNo E(Pa) nu rho(kg/m3) yield(Pa) tensile(Pa) compressive(Pa)\n";
  for (const auto& material : materials) {
    output << material.materialNo << ' ' << material.elasticModulus << ' ' << material.poissonRatio << ' '
           << material.density << ' ' << material.yieldStrength << ' ' << material.tensileStrength << ' '
           << material.compressiveStrength << '\n';
  }
}

// 打印节点表，包括约束、自由度编号、节点外力和区域/材料编号。
void PrintNodes(const std::vector<NodeData>& nodes, std::ostream& output) {
  PrintDivider(output, "NODES");
  output << "# nodeNo x y fixUx fixUy dofUx dofUy Fx Fy matNo regionNo\n";
  for (const auto& node : nodes) {
    output << node.nodeNo << ' ' << node.x << ' ' << node.y << ' '
           << (node.fixUx ? 1 : 0) << ' ' << (node.fixUy ? 1 : 0) << ' '
           << node.dofUx << ' ' << node.dofUy << ' ' << node.forceX << ' ' << node.forceY << ' '
           << node.materialNo << ' ' << node.regionNo << '\n';
  }
}

// 打印三角形单元表，包括节点连接、面积、质心和材料参数。
void PrintElements(const std::vector<ElementData>& elements, std::ostream& output) {
  PrintDivider(output, "ELEMENTS");
  output << "# elemNo n1 n2 n3 area cx cy matNo E(Pa) nu rho yield tensile compressive\n";
  for (const auto& element : elements) {
    output << element.elementNo << ' ' << element.node1 << ' ' << element.node2 << ' ' << element.node3 << ' '
           << element.area << ' ' << element.centroidX << ' ' << element.centroidY << ' ' << element.materialNo << ' '
           << element.elasticModulus << ' ' << element.poissonRatio << ' ' << element.density << ' '
           << element.yieldStrength << ' ' << element.tensileStrength << ' ' << element.compressiveStrength << '\n';
  }
}

// 打印单元等效节点载荷表。
void PrintElementNodeLoads(const std::vector<ElementNodeLoadData>& loads, std::ostream& output) {
  PrintDivider(output, "ELEMENT NODE LOADS");
  output << "# elemNo Fx1 Fy1 Fx2 Fy2 Fx3 Fy3\n";
  for (const auto& load : loads) {
    output << load.elementNo << ' ' << load.forceX1 << ' ' << load.forceY1 << ' '
           << load.forceX2 << ' ' << load.forceY2 << ' ' << load.forceX3 << ' ' << load.forceY3 << '\n';
  }
}

// 打印前端导出的警告和 C++ 解析器产生的警告。
void PrintWarnings(const CalculationModel& model, std::ostream& output) {
  PrintDivider(output, "WARNINGS");
  if (model.fileWarnings.empty() && model.parserWarnings.empty()) {
    output << "No warnings.\n";
    return;
  }
  for (const auto& warning : model.fileWarnings) {
    output << "[file] " << warning << '\n';
  }
  for (const auto& warning : model.parserWarnings) {
    output << "[parser] " << warning << '\n';
  }
}

}  // namespace

void ValidateCalculationModel(CalculationModel& model) {
  ValidateCalculationModelImpl(model);
}

// 从当前工作目录开始向上搜索 calculation-data/calculation-input.txt。
// 这样无论从项目根目录、Visual Studio 输出目录还是工程目录启动，都能找到同一份输入文件。
std::filesystem::path FindDefaultCalculationInputPath() {
  const std::filesystem::path relativeInputPath = std::filesystem::path(kDataDirectory) / kInputFilename;
  std::vector<std::filesystem::path> candidates;

  std::filesystem::path cursor = std::filesystem::current_path();
  for (int depth = 0; depth < 8 && !cursor.empty(); ++depth) {
    candidates.push_back(cursor / relativeInputPath);
    if (cursor == cursor.parent_path()) {
      break;
    }
    cursor = cursor.parent_path();
  }

  for (const auto& candidate : candidates) {
    if (std::filesystem::exists(candidate)) {
      return std::filesystem::canonical(candidate);
    }
  }

  std::ostringstream message;
  message << "Cannot find " << relativeInputPath.string() << ". Tried:\n";
  for (const auto& candidate : candidates) {
    message << "  " << candidate.u8string() << '\n';
  }
  throw std::runtime_error(message.str());
}

// 读取输入文件并按固定文本格式解析成 CalculationModel。
// 解析算法是“逐行读取 + 当前段落状态机”：段落头决定后续数据行使用哪种结构解析。
CalculationModel LoadCalculationInput(const std::filesystem::path& inputPath) {
  // 使用较大的显式文件缓冲区，减少大模型 TXT 的底层读取调用次数。
  std::vector<char> inputBuffer(1024 * 1024);
  std::ifstream input;
  input.rdbuf()->pubsetbuf(inputBuffer.data(), static_cast<std::streamsize>(inputBuffer.size()));
  input.open(inputPath, std::ios::in | std::ios::binary);
  if (!input) {
    throw std::runtime_error("Cannot open calculation input file: " + inputPath.u8string());
  }

  CalculationModel model;
  model.sourcePath = inputPath;

  Section section = Section::none;
  bool headerRead = false;
  std::string line;
  int lineNumber = 0;

  while (std::getline(input, line)) {
    ++lineNumber;
    const std::string_view trimmed = TrimView(RemoveUtf8Bom(line));
    if (trimmed.empty()) {
      continue;
    }

    if (!headerRead) {
      model.header.assign(trimmed);
      if (model.header != kExpectedHeader) {
        throw std::runtime_error("Unsupported calculation input header: " + model.header);
      }
      headerRead = true;
      continue;
    }

    if (EqualsIgnoreCase(trimmed, "END")) {
      break;
    }

    if (ParseSectionHeader(trimmed, section)) {
      continue;
    }

    if (section == Section::warnings) {
      if (IsComment(trimmed)) {
        const std::string warning = Trim(std::string(trimmed.substr(1)));
        if (!StartsWith(ToUpper(warning), "COUNT=") && !warning.empty()) {
          model.fileWarnings.push_back(warning);
        }
      } else {
        model.fileWarnings.emplace_back(trimmed);
      }
      continue;
    }

    if (IsComment(trimmed)) {
      continue;
    }

    if (section == Section::none) {
      if (StartsWith(trimmed, "MODEL ")) {
        model.modelName = AfterKeyword(trimmed, "MODEL");
      } else if (StartsWith(trimmed, "GENERATED_AT ")) {
        model.generatedAt = AfterKeyword(trimmed, "GENERATED_AT");
      } else if (StartsWith(trimmed, "UNITS ")) {
        ParseUnitsLine(trimmed, model.units);
      } else if (StartsWith(trimmed, "COUNTS ")) {
        ParseCountsLine(trimmed, model.counts);
        if (model.counts.materials > 0) {
          model.materials.reserve(static_cast<std::size_t>(model.counts.materials));
        }
        if (model.counts.nodes > 0) {
          model.nodes.reserve(static_cast<std::size_t>(model.counts.nodes));
        }
        if (model.counts.elements > 0) {
          model.elements.reserve(static_cast<std::size_t>(model.counts.elements));
          model.elementNodeLoads.reserve(static_cast<std::size_t>(model.counts.elements));
        }
      }
      continue;
    }

    if (section == Section::materials) {
      model.materials.push_back(ParseDataLine<MaterialData>(trimmed, lineNumber, "MATERIALS"));
    } else if (section == Section::nodes) {
      model.nodes.push_back(ParseDataLine<NodeData>(trimmed, lineNumber, "NODES"));
    } else if (section == Section::elements) {
      model.elements.push_back(ParseDataLine<ElementData>(trimmed, lineNumber, "ELEMENTS"));
    } else if (section == Section::elementNodeLoads) {
      model.elementNodeLoads.push_back(ParseDataLine<ElementNodeLoadData>(trimmed, lineNumber, "ELEMENT_NODE_LOADS"));
    }
  }

  if (!headerRead) {
    throw std::runtime_error("Empty calculation input file.");
  }

  ValidateCalculationModel(model);
  return model;
}

// 将导入结果完整打印到控制台，作为 C++ 计算核心调试的第一层验证。
void PrintCalculationModel(const CalculationModel& model, std::ostream& output) {
  ConfigureConsoleForUtf8();
  output << std::setprecision(10);

  PrintDivider(output, "CALCULATION INPUT");
  output << "Source file: " << model.sourcePath.u8string() << '\n';
  output << "Header: " << model.header << '\n';
  output << "Model: " << model.modelName << '\n';
  output << "Generated at: " << model.generatedAt << '\n';
  output << "Units: LENGTH=" << model.units.length
         << " FORCE=" << model.units.force
         << " ELASTIC_MODULUS=" << model.units.elasticModulus
         << " DENSITY=" << model.units.density
         << " STRENGTH=" << model.units.strength << '\n';

  PrintDivider(output, "COUNTS");
  output << "Declared nodes: " << model.counts.nodes << ", parsed nodes: " << model.nodes.size() << '\n';
  output << "Declared elements: " << model.counts.elements << ", parsed elements: " << model.elements.size() << '\n';
  output << "Declared materials: " << model.counts.materials << ", parsed materials: " << model.materials.size() << '\n';
  output << "Declared point loads: " << model.counts.pointLoads << '\n';
  output << "Declared distributed loads: " << model.counts.distributedLoads << '\n';
  output << "Declared body loads: " << model.counts.bodyLoads << '\n';
  output << "Parsed element load rows: " << model.elementNodeLoads.size() << '\n';

  PrintMaterials(model.materials, output);
  PrintNodes(model.nodes, output);
  PrintElements(model.elements, output);
  PrintElementNodeLoads(model.elementNodeLoads, output);
  PrintWarnings(model, output);
}

}  // namespace fem
