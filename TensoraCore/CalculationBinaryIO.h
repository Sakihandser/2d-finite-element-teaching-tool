#pragma once

#include <iosfwd>
#include <vector>

#include <Eigen/Dense>

#include "CalculationData.h"

namespace fem {

// Windows 下把 stdin/stdout 切换为二进制模式，避免 CR/LF 转换破坏管道数据。
void ConfigureBinaryStandardStreams();

// 从 Node.js 标准输入管道读取 FEM_CALCULATION_BINARY_V1 模型。
CalculationModel LoadCalculationModelBinary(std::istream& input);

// 把计算结果以 FEM_CALCULATION_RESULT_BINARY_V1 写入 Node.js 标准输出管道。
void WriteCalculationResultBinary(
    std::ostream& output,
    const CalculationModel& model,
    const Eigen::VectorXd& nodeDisplacement,
    const std::vector<Eigen::Matrix2d>& elementStrain,
    const std::vector<Eigen::Matrix2d>& elementStress,
    const Eigen::VectorXi& securityCheckList);

}  // namespace fem
