#pragma once

#include <filesystem>
#include <vector>

#include <Eigen/Dense>

#include "CalculationData.h"

namespace fem {

constexpr const char* kCalculationResultFilename = "calculation-result.txt";

// 根据输入文件位置得到固定结果文件路径：calculation-data/calculation-result.txt。
std::filesystem::path FindDefaultCalculationResultPath(const CalculationModel& model);

// 将节点位移、单元应变、单元应力和安全校核结果写入固定 TXT 文件。
std::filesystem::path ExportCalculationResults(
    const CalculationModel& model,
    const Eigen::VectorXd& nodeDisplacement,
    const std::vector<Eigen::Matrix2d>& elementStrain,
    const std::vector<Eigen::Matrix2d>& elementStress,
    const Eigen::VectorXi& securityCheckList);

}  // namespace fem
