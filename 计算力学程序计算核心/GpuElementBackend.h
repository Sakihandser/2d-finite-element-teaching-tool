#pragma once

#include "ElementCalculations.h"
#include <array>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace fem {

// Packed input shared by the CPU formulas and OpenCL kernels; units stay unchanged.
struct GpuElementInput {
    std::array<double, 6> coordinates{};
    double poissonRatio = 0;
    double elasticModulus = 0;
    double area = 0;
};

// Optional accelerator. A failed call never commits partial output; callers run
// the existing CPU loop. No OpenCL DLL or SDK is required on CPU-only machines.
class GpuElementBackend {
public:
    GpuElementBackend(std::size_t elementCount, const std::string& mode,
                      const std::string& deviceFilter = "",
                      const std::string& measuredMinimumElements = "");
    ~GpuElementBackend();
    GpuElementBackend(const GpuElementBackend&) = delete;
    GpuElementBackend& operator=(const GpuElementBackend&) = delete;
    bool Available() const;
    const std::string& Status() const { return status_; }
    bool Stiffness(const std::vector<GpuElementInput>& inputs,
                   std::vector<ElementStiffnessMatrix>& output);
    bool StrainStress(const std::vector<GpuElementInput>& inputs,
                      const std::vector<ElementDisplacementVector>& displacement,
                      std::vector<StrainStressMatrix>& output);
private:
    struct State;
    std::unique_ptr<State> state_;
    std::string status_;
};
} // namespace fem
