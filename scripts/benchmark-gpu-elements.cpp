// Diagnostic only: retain one GPU context over all rounds to separate process
// startup from the element computation/transfer costs. This is not a new solver.
#include "../TensoraCore/GpuElementBackend.h"
#include <algorithm>
#include <chrono>
#include <iostream>
#include <iomanip>
#include <stdexcept>
#include <vector>
#include <omp.h>

using Clock = std::chrono::steady_clock;
template<class F> double Time(F fn) {
    const auto start = Clock::now(); fn();
    return std::chrono::duration<double, std::milli>(Clock::now()-start).count();
}
double Median(std::vector<double> times) {
    std::sort(times.begin(),times.end()); return times[times.size()/2];
}

int main() {
    const auto started = Clock::now();
    fem::GpuElementBackend gpu(2048,"gpu");
    if (!gpu.Available()) { std::cerr << gpu.Status(); return 1; }
    std::cerr << gpu.Status() << "; context init ms="
              << std::chrono::duration<double,std::milli>(Clock::now()-started).count() << '\n';
    omp_set_dynamic(0);
    std::cout << "elements,cpu_stiffness_ms,gpu_stiffness_ms,cpu_stress_ms,gpu_stress_ms\n";
    for (const int count : {2048,8192,32768,131072,294912,524288,991232}) {
        std::vector<fem::GpuElementInput> input(count);
        std::vector<fem::ElementDisplacementVector> displacement(count);
        std::vector<fem::ElementStiffnessMatrix> stiffness(count), gpuStiffness;
        std::vector<fem::StrainStressMatrix> stress(count), gpuStress;
        for (int i=0;i<count;++i) {
            const double scale=1.0+(i%17)*0.01, x=(i%100)*0.003, y=(i/100)*0.003;
            input[i]={{x,y,x+0.002*scale,y,x,y+0.003}, i%2?0.17:0.32, i%2?70e9:140e9, 0.000003*scale};
            displacement[i] << 1e-6,2e-6,3e-6,-1e-6,-2e-6,1e-6;
        }
        auto cpuKe = [&] {
#pragma omp parallel for schedule(static) num_threads(8)
            for (int i=0;i<count;++i) {
                const auto& e=input[i]; const auto& c=e.coordinates;
                stiffness[i]=fem::CalculateElementStiffness(c[0],c[1],c[2],c[3],c[4],c[5],e.poissonRatio,e.elasticModulus,e.area);
            }
        };
        auto cpuStress = [&] {
#pragma omp parallel for schedule(static) num_threads(8)
            for (int i=0;i<count;++i) {
                const auto& e=input[i]; const auto& c=e.coordinates;
                stress[i]=fem::CalculateElementStrainStress(c[0],c[1],c[2],c[3],c[4],c[5],e.poissonRatio,e.elasticModulus,e.area,displacement[i]);
            }
        };
        auto gpuKe = [&] { if (!gpu.Stiffness(input,gpuStiffness)) throw std::runtime_error(gpu.Status()); };
        auto gpuPost = [&] { if (!gpu.StrainStress(input,displacement,gpuStress)) throw std::runtime_error(gpu.Status()); };
        cpuKe(); cpuStress(); gpuKe(); gpuPost();
        for (int i=0;i<count;++i) {
            if (!stiffness[i].isApprox(gpuStiffness[i],1e-11) ||
                !stress[i].block<2,2>(0,0).isApprox(gpuStress[i].block<2,2>(0,0),1e-10) ||
                !stress[i].block<2,2>(0,2).isApprox(gpuStress[i].block<2,2>(0,2),1e-10)) {
                std::cerr << "CPU/GPU parity failure at " << i; return 2;
            }
        }
        std::vector<double> cKe,gKe,cPost,gPost;
        for (int repeat=0;repeat<5;++repeat) {
            if (repeat%2) {
                gKe.push_back(Time(gpuKe)); cKe.push_back(Time(cpuKe));
                gPost.push_back(Time(gpuPost)); cPost.push_back(Time(cpuStress));
            } else {
                cKe.push_back(Time(cpuKe)); gKe.push_back(Time(gpuKe));
                cPost.push_back(Time(cpuStress)); gPost.push_back(Time(gpuPost));
            }
        }
        std::cout << count << ',' << std::fixed << std::setprecision(3)
                  << Median(cKe) << ',' << Median(gKe) << ',' << Median(cPost) << ',' << Median(gPost) << std::endl;
    }
}
