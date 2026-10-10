#pragma once

#include <Eigen/Dense>

namespace fem {

using ElementStiffnessMatrix = Eigen::Matrix<double, 6, 6>;
using ElementDisplacementVector = Eigen::Matrix<double, 6, 1>;
using StrainStressMatrix = Eigen::Matrix<double, 2, 4>;

// 三节点常应变三角形单元（CST/TRI3）的 6x6 平面应力刚度矩阵。
ElementStiffnessMatrix CalculateElementStiffness(
    double n1x, double n1y,
    double n2x, double n2y,
    double n3x, double n3y,
    double poissonRatio, double elasticModulus, double area);

// 返回 [应变 2x2 | 应力 2x2]，剪应变在结果张量中转换为张量剪应变。
StrainStressMatrix CalculateElementStrainStress(
    double n1x, double n1y,
    double n2x, double n2y,
    double n3x, double n3y,
    double poissonRatio, double elasticModulus, double area,
    const ElementDisplacementVector& elementDisplacement);

// 根据二维对称应力张量的解析主应力执行强度安全校核。
int CheckElementSecurity(
    double yieldStrength,
    double tensileStrength,
    double compressiveStrength,
    const Eigen::Matrix2d& stress);

}  // namespace fem
