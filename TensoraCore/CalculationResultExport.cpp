#include "CalculationResultExport.h"

#include <charconv>
#include <cctype>
#include <cmath>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

namespace fem {
namespace {

std::string CurrentTimestamp() {
  const std::time_t now = std::time(nullptr);
  std::tm localTime{};
#ifdef _WIN32
  localtime_s(&localTime, &now);
#else
  localtime_r(&now, &localTime);
#endif
  std::ostringstream stream;
  stream << std::put_time(&localTime, "%Y-%m-%dT%H:%M:%S");
  return stream.str();
}

std::string TextToken(const std::string& value) {
  std::string token = value.empty() ? "unnamed_model" : value;
  for (char& ch : token) {
    if (std::isspace(static_cast<unsigned char>(ch))) {
      ch = '_';
    }
  }
  return token;
}

void AppendNumber(std::string& output, double value) {
  if (!std::isfinite(value) || std::abs(value) < 1e-14) {
    output.push_back('0');
    return;
  }
  char buffer[64];
  const auto result = std::to_chars(
      buffer, buffer + sizeof(buffer), value, std::chars_format::general, 12);
  if (result.ec != std::errc{}) {
    throw std::runtime_error("Cannot format floating-point calculation result.");
  }
  output.append(buffer, result.ptr);
}

template <typename Integer>
void AppendInteger(std::string& output, Integer value) {
  char buffer[32];
  const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
  if (result.ec != std::errc{}) {
    throw std::runtime_error("Cannot format integer calculation result.");
  }
  output.append(buffer, result.ptr);
}

const char* SafetyText(int safetyCode) {
  switch (safetyCode) {
    case 0:
      return "OK";
    case 1:
      return "COMPRESSION_LIMIT";
    case 2:
      return "TENSILE_LIMIT";
    case 3:
      return "YIELD_LIMIT";
    default:
      return "UNKNOWN";
  }
}

double DisplacementValue(const Eigen::VectorXd& nodeDisplacement, int dofNumber, int nodeNo, const char* direction) {
  if (dofNumber <= 0 || dofNumber > nodeDisplacement.size()) {
    std::ostringstream message;
    message << "Node " << nodeNo << " has invalid " << direction << " dof number " << dofNumber << ".";
    throw std::runtime_error(message.str());
  }
  return nodeDisplacement(dofNumber - 1);
}

int ResultIndexForElement(int elementNo, int resultSize, const char* resultName) {
  const int index = elementNo - 1;
  if (index < 0 || index >= resultSize) {
    std::ostringstream message;
    message << "Element " << elementNo << " has invalid " << resultName << " result index.";
    throw std::runtime_error(message.str());
  }
  return index;
}

std::string UnitOrDefault(const std::string& value, const std::string& fallback) {
  return value.empty() ? fallback : value;
}

}  // namespace

std::filesystem::path FindDefaultCalculationResultPath(const CalculationModel& model) {
  if (!model.sourcePath.empty()) {
    return model.sourcePath.parent_path() / kCalculationResultFilename;
  }
  return FindDefaultCalculationInputPath().parent_path() / kCalculationResultFilename;
}

std::filesystem::path ExportCalculationResults(
    const CalculationModel& model,
    const Eigen::VectorXd& nodeDisplacement,
    const std::vector<Eigen::Matrix2d>& elementStrain,
    const std::vector<Eigen::Matrix2d>& elementStress,
    const Eigen::VectorXi& securityCheckList) {
  const std::filesystem::path outputPath = FindDefaultCalculationResultPath(model);
  std::filesystem::create_directories(outputPath.parent_path());

  // 先在连续内存中构造结果，再一次性写入文件，避免数万个小型格式化和写调用。
  std::string content;
  content.reserve(1024 + model.nodes.size() * 80 + model.elements.size() * 220);
  content.append("FEM_CALCULATION_RESULT_TXT_V1\nMODEL ");
  content.append(TextToken(model.modelName));
  content.append("\nGENERATED_AT ");
  content.append(CurrentTimestamp());
  content.append("\nSOURCE_INPUT ");
  content.append(model.sourcePath.u8string());
  content.append("\nUNITS DISPLACEMENT=");
  content.append(UnitOrDefault(model.units.length, "model"));
  content.append(" STRAIN=1 STRESS=");
  content.append(UnitOrDefault(model.units.elasticModulus, "Pa"));
  content.append("\nCOUNTS NODES=");
  AppendInteger(content, model.nodes.size());
  content.append(" ELEMENTS=");
  AppendInteger(content, model.elements.size());
  content.append("\n\nNODE_DISPLACEMENTS\n# nodeNo ux uy magnitude\n");

  for (const auto& node : model.nodes) {
    const double ux = DisplacementValue(nodeDisplacement, node.dofUx, node.nodeNo, "ux");
    const double uy = DisplacementValue(nodeDisplacement, node.dofUy, node.nodeNo, "uy");
    AppendInteger(content, node.nodeNo);
    content.push_back(' ');
    AppendNumber(content, ux);
    content.push_back(' ');
    AppendNumber(content, uy);
    content.push_back(' ');
    AppendNumber(content, std::hypot(ux, uy));
    content.push_back('\n');
  }

  content.append("\nELEMENT_RESULTS\n");
  content.append("# elemNo strain_xx strain_xy strain_yx strain_yy stress_xx stress_xy stress_yx stress_yy safetyCode safetyText\n");
  for (const auto& element : model.elements) {
    const int strainIndex = ResultIndexForElement(element.elementNo, static_cast<int>(elementStrain.size()), "strain");
    const int stressIndex = ResultIndexForElement(element.elementNo, static_cast<int>(elementStress.size()), "stress");
    const int safetyIndex = ResultIndexForElement(element.elementNo, static_cast<int>(securityCheckList.size()), "safety");
    const int safetyCode = securityCheckList(safetyIndex);
    const Eigen::Matrix2d& strain = elementStrain[strainIndex];
    const Eigen::Matrix2d& stress = elementStress[stressIndex];

    AppendInteger(content, element.elementNo);
    const double values[] = {
        strain(0, 0), strain(0, 1), strain(1, 0), strain(1, 1),
        stress(0, 0), stress(0, 1), stress(1, 0), stress(1, 1)};
    for (const double value : values) {
      content.push_back(' ');
      AppendNumber(content, value);
    }
    content.push_back(' ');
    AppendInteger(content, safetyCode);
    content.push_back(' ');
    content.append(SafetyText(safetyCode));
    content.push_back('\n');
  }

  content.append("\nSAFETY_CODE_MEANING\n");
  content.append("# 0 OK\n# 1 COMPRESSION_LIMIT\n# 2 TENSILE_LIMIT\n# 3 YIELD_LIMIT\nEND\n");

  std::ofstream output(outputPath, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("Cannot open calculation result file: " + outputPath.u8string());
  }
  output.write(content.data(), static_cast<std::streamsize>(content.size()));
  if (!output) {
    throw std::runtime_error("Failed while writing calculation result file: " + outputPath.u8string());
  }

  return outputPath;
}

}  // namespace fem
