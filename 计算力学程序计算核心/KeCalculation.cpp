#include "ElementCalculations.h"

#include <Eigen/Dense>

namespace fem {

// 计算三节点常应变三角形单元（CST/TRI3）的平面应力单元刚度矩阵。
// 输入为三个节点坐标、泊松比 nu、弹性模量 E 和单元面积 A。
// 输出矩阵自由度顺序为 [n1ux, n1uy, n2ux, n2uy, n3ux, n3uy]。
ElementStiffnessMatrix CalculateElementStiffness(
	double n1x, double n1y, double n2x, double n2y, double n3x, double n3y,
	double nu, double E, double A)
{
	ElementStiffnessMatrix Ke;
	Eigen::Vector3d b;
	Eigen::Vector3d c;

	// b、c 是三角形线性形函数导数中的几何系数。
	// 对常应变三角形单元，B 矩阵在单元内部为常数，因此 Ke 可直接由 b/c 组合得到。
	b(0) = n2y - n3y;
	b(1) = n3y - n1y;
	b(2) = n1y - n2y;
	c(0) = n3x - n2x;
	c(1) = n1x - n3x;
	c(2) = n2x - n1x;

	// 按 3x3 节点块装配 6x6 单元刚度矩阵。
	// 这里采用平面应力材料矩阵 D = E/(1-nu^2) * [[1,nu,0],[nu,1,0],[0,0,(1-nu)/2]]。
	for (int i = 0; i < 3; i++)
	{
		for (int j = 0; j < 3; j++)
		{
			Ke(2 * i, 2 * j) = b(i) * b(j) + (1 - nu) / 2 * c(i) * c(j);
			Ke(2 * i + 1, 2 * j) = nu * c(i) * b(j) + (1 - nu) / 2 * b(i) * c(j);
			Ke(2 * i, 2 * j + 1) = nu * b(i) * c(j) + (1 - nu) / 2 * c(i) * b(j);
			Ke(2 * i + 1, 2 * j + 1) = c(i) * c(j) + (1 - nu) / 2 * b(i) * b(j);
		}
	}
	// B 矩阵中含有 1/(2A)，Ke = A * B^T * D * B 后得到整体系数 E/[4A(1-nu^2)]。
	// 当前模型默认单元厚度 t=1；如果后续加入厚度，应把 E 改成 E*t。
	return (E / (4 * (1 - nu * nu) * A)) * Ke;
}

}  // namespace fem
