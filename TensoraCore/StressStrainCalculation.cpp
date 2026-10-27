#include "ElementCalculations.h"

#include <Eigen/Dense>
#include <cmath>
#include <stdexcept>

namespace fem {

StrainStressMatrix CalculateElementStrainStress(
	double n1x, double n1y, double n2x, double n2y, double n3x, double n3y,
	double nu, double E, double A,
	const ElementDisplacementVector& elementDisplacement)
{
	StrainStressMatrix strainStress = StrainStressMatrix::Zero();
	Eigen::Vector3d b;
	Eigen::Vector3d c;

	// b、c 是三节点三角形单元线性形函数的几何系数。
	// 节点按逆时针顺序、面积 A 为正时，c_i = x_k - x_j。
	b(0) = n2y - n3y;
	b(1) = n3y - n1y;
	b(2) = n1y - n2y;
	c(0) = n3x - n2x;
	c(1) = n1x - n3x;
	c(2) = n2x - n1x;

	Eigen::Matrix<double, 3, 6> B = Eigen::Matrix<double, 3, 6>::Zero(); // 应变-位移矩阵 B，输出工程剪应变 gamma_xy。
	B(0, 0) = b(0);
	B(0, 2) = b(1);
	B(0, 4) = b(2);
	B(1, 1) = c(0);
	B(1, 3) = c(1);
	B(1, 5) = c(2);
	B(2, 1) = b(0);
	B(2, 3) = b(1);
	B(2, 5) = b(2);
	B(2, 0) = c(0);
	B(2, 2) = c(1);
	B(2, 4) = c(2);
	// Shape gradients use the signed Jacobian. Area is unsigned in the input;
	// dividing by 2*A reverses all reported strains/stresses on clockwise cells.
	const double determinant = (n2x-n1x)*(n3y-n1y)-(n3x-n1x)*(n2y-n1y);
	if (!std::isfinite(determinant) || determinant == 0.0)
		throw std::runtime_error("Cannot evaluate a degenerate TRI3 element.");
	B = B / determinant;

	Eigen::Matrix3d D = Eigen::Matrix3d::Zero();// 平面应力本构矩阵 D。
	D(0, 0) = D(1, 1) = 1;
	D(0, 1) = D(1, 0) = nu;
	D(2, 2) = (1 - nu) / 2;
	D = D * E / (1 - nu * nu);

	// 先计算应变向量 [epsilon_x, epsilon_y, gamma_xy]，再计算应力向量 [sigma_x, sigma_y, tau_xy]。
	const Eigen::Vector3d strain = B * elementDisplacement;
	const Eigen::Vector3d stress = D * strain;
	strainStress(0, 0) = strain(0);
	strainStress(0, 1) = strainStress(1, 0) = 0.5 * strain(2);
	strainStress(1, 1) = strain(1);
	strainStress(0, 2) = stress(0);
	strainStress(0, 3) = strainStress(1, 2) = stress(2);
	strainStress(1, 3) = stress(1);

	return strainStress;
}

}  // namespace fem
