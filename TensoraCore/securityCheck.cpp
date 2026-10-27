#include "ElementCalculations.h"

#include <cmath>
#include <Eigen/Dense>

namespace fem {

int CheckElementSecurity(
	double yield, double tensile, double compressive,
	const Eigen::Matrix2d& stress)
{
	// 二维对称矩阵的解析特征值。避免为每个单元创建通用特征值求解器。
	const double sigmaX = stress(0, 0);
	const double sigmaY = stress(1, 1);
	const double tauXY = 0.5 * (stress(0, 1) + stress(1, 0));
	const double mean = 0.5 * (sigmaX + sigmaY);
	const double radius = std::hypot(0.5 * (sigmaX - sigmaY), tauXY);
	const double sigma1 = mean + radius;  // 第一主应力，较大的主应力。
	const double sigma2 = mean - radius;  // 第二主应力，较小的主应力。
	
	int i = 0; // 安全检查标记：0 正常，1 抗压超限，2 抗拉超限，3 屈服超限。

	if (compressive != 0.0) // 检查抗压强度。
	{
		if (sigma2 < 0)
		{
			if (sigma2 <= (-1) * compressive)
			{
				i = 1;
				return i;
			}
		}
	}

	if (tensile != 0.0) // 检查抗拉强度。
	{
		if (sigma1 > 0)
		{
			if (sigma1 >= tensile)
			{
				i = 2;
				return i;
			}
		}
	}

	if (yield != 0.0) // 检查屈服强度。
	{
		if (std::abs(sigma1) >= yield || std::abs(sigma2) >= yield)
		{
			i = 3;
			return i;
		}
	}

	return i;
}

}  // namespace fem
