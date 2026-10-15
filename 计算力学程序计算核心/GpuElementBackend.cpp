#include "GpuElementBackend.h"
#include <algorithm>
#include <cmath>
#include <charconv>
#include <stdexcept>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#define CL_TARGET_OPENCL_VERSION 120
#include "vendor/opencl/CL/cl.h"

namespace {
void Check(cl_int code, const char* operation) {
    if (code != CL_SUCCESS)
        throw std::runtime_error(std::string(operation) + " (OpenCL " + std::to_string(code) + ")");
}

// Load only the system ICD loader, never a DLL found in the working directory.
struct OpenClApi {
    HMODULE library = nullptr;
#define FEM_CL_FUNCTION(name) decltype(&::name) name = nullptr;
    FEM_CL_FUNCTION(clGetPlatformIDs)
    FEM_CL_FUNCTION(clGetDeviceIDs)
    FEM_CL_FUNCTION(clGetDeviceInfo)
    FEM_CL_FUNCTION(clCreateContext)
    FEM_CL_FUNCTION(clCreateCommandQueue)
    FEM_CL_FUNCTION(clCreateProgramWithSource)
    FEM_CL_FUNCTION(clBuildProgram)
    FEM_CL_FUNCTION(clGetProgramBuildInfo)
    FEM_CL_FUNCTION(clCreateKernel)
    FEM_CL_FUNCTION(clCreateBuffer)
    FEM_CL_FUNCTION(clSetKernelArg)
    FEM_CL_FUNCTION(clEnqueueWriteBuffer)
    FEM_CL_FUNCTION(clEnqueueReadBuffer)
    FEM_CL_FUNCTION(clEnqueueNDRangeKernel)
    FEM_CL_FUNCTION(clReleaseMemObject)
    FEM_CL_FUNCTION(clReleaseKernel)
    FEM_CL_FUNCTION(clReleaseProgram)
    FEM_CL_FUNCTION(clReleaseCommandQueue)
    FEM_CL_FUNCTION(clReleaseContext)
#undef FEM_CL_FUNCTION
    OpenClApi() {
        library = LoadLibraryExW(L"OpenCL.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!library) throw std::runtime_error("system OpenCL runtime unavailable");
        try {
#define FEM_CL_LOAD(name) name = reinterpret_cast<decltype(name)>(GetProcAddress(library, #name)); if (!name) throw std::runtime_error("missing " #name);
            FEM_CL_LOAD(clGetPlatformIDs)
            FEM_CL_LOAD(clGetDeviceIDs)
            FEM_CL_LOAD(clGetDeviceInfo)
            FEM_CL_LOAD(clCreateContext)
            FEM_CL_LOAD(clCreateCommandQueue)
            FEM_CL_LOAD(clCreateProgramWithSource)
            FEM_CL_LOAD(clBuildProgram)
            FEM_CL_LOAD(clGetProgramBuildInfo)
            FEM_CL_LOAD(clCreateKernel)
            FEM_CL_LOAD(clCreateBuffer)
            FEM_CL_LOAD(clSetKernelArg)
            FEM_CL_LOAD(clEnqueueWriteBuffer)
            FEM_CL_LOAD(clEnqueueReadBuffer)
            FEM_CL_LOAD(clEnqueueNDRangeKernel)
            FEM_CL_LOAD(clReleaseMemObject)
            FEM_CL_LOAD(clReleaseKernel)
            FEM_CL_LOAD(clReleaseProgram)
            FEM_CL_LOAD(clReleaseCommandQueue)
            FEM_CL_LOAD(clReleaseContext)
#undef FEM_CL_LOAD
        } catch (...) { FreeLibrary(library); library = nullptr; throw; }
    }
    ~OpenClApi() { if (library) FreeLibrary(library); }
};

const char* kernelSource = R"CLC(
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#pragma OPENCL FP_CONTRACT OFF
__kernel void stiffness(__global const double* data, __global double* out) {
    size_t e = get_global_id(0); size_t p = e * 9;
    double b[3] = {data[p+3]-data[p+5], data[p+5]-data[p+1], data[p+1]-data[p+3]};
    double c[3] = {data[p+4]-data[p+2], data[p]-data[p+4], data[p+2]-data[p]};
    double nu = data[p+6], s = (1.0-nu)/2.0;
    double scale = data[p+7]/(4.0*(1.0-nu*nu)*data[p+8]);
    for (int i=0; i<3; ++i) for (int j=0; j<3; ++j) {
        size_t base = e*36;
        out[base+(2*i)*6+2*j] = scale*(b[i]*b[j]+s*c[i]*c[j]);
        out[base+(2*i+1)*6+2*j] = scale*(nu*c[i]*b[j]+s*b[i]*c[j]);
        out[base+(2*i)*6+2*j+1] = scale*(nu*b[i]*c[j]+s*c[i]*b[j]);
        out[base+(2*i+1)*6+2*j+1] = scale*(c[i]*c[j]+s*b[i]*b[j]);
    }
}
__kernel void strainStress(__global const double* data, __global double* out,
                           __global const double* displacement) {
    size_t e = get_global_id(0); size_t p = e*9;
    double b[3] = {data[p+3]-data[p+5], data[p+5]-data[p+1], data[p+1]-data[p+3]};
    double c[3] = {data[p+4]-data[p+2], data[p]-data[p+4], data[p+2]-data[p]};
    double ex=0.0, ey=0.0, gamma=0.0, area2=2.0*data[p+8];
    for (int i=0; i<3; ++i) {
        double ux=displacement[e*6+2*i], uy=displacement[e*6+2*i+1];
        ex += (b[i]/area2)*ux; ey += (c[i]/area2)*uy;
        gamma += (c[i]/area2)*ux + (b[i]/area2)*uy;
    }
    double nu=data[p+6], E=data[p+7], denominator=1.0-nu*nu;
    double d=E/denominator, coupling=(nu*E)/denominator;
    double sx=d*ex+coupling*ey, sy=coupling*ex+d*ey;
    double tau=(((1.0-nu)/2.0*E)/denominator)*gamma;
    out[e*8]=ex; out[e*8+1]=gamma/2.0; out[e*8+2]=sx; out[e*8+3]=tau;
    out[e*8+4]=gamma/2.0; out[e*8+5]=ey; out[e*8+6]=tau; out[e*8+7]=sy;
}
)CLC";
constexpr std::size_t batchCapacity = 16384;
} // namespace
#endif

namespace fem {
struct GpuElementBackend::State {
#ifdef _WIN32
    OpenClApi api;
    cl_context context = nullptr;
    cl_command_queue queue = nullptr;
    cl_program program = nullptr;
    cl_kernel stiffness = nullptr, strainStress = nullptr;
    cl_mem input = nullptr, output = nullptr, displacement = nullptr;
    std::string deviceName;
    ~State() {
        if (displacement) api.clReleaseMemObject(displacement);
        if (output) api.clReleaseMemObject(output);
        if (input) api.clReleaseMemObject(input);
        if (strainStress) api.clReleaseKernel(strainStress);
        if (stiffness) api.clReleaseKernel(stiffness);
        if (program) api.clReleaseProgram(program);
        if (queue) api.clReleaseCommandQueue(queue);
        if (context) api.clReleaseContext(context);
    }
    void Initialize(const std::string& filter) {
        cl_uint count = 0;
        Check(api.clGetPlatformIDs(0, nullptr, &count), "enumerate platforms");
        std::vector<cl_platform_id> platforms(count);
        Check(api.clGetPlatformIDs(count, platforms.data(), nullptr), "get platforms");
        cl_device_id selected = nullptr;
        cl_uint bestUnits = 0;
        for (auto platform : platforms) {
            cl_uint deviceCount = 0;
            if (api.clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 0, nullptr, &deviceCount) != CL_SUCCESS) continue;
            std::vector<cl_device_id> devices(deviceCount);
            if (api.clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, deviceCount, devices.data(), nullptr) != CL_SUCCESS) continue;
            for (auto device : devices) {
                cl_device_fp_config fp64 = 0;
                cl_bool available = CL_FALSE, compiler = CL_FALSE;
                cl_uint units = 0;
                char name[512]{};
                if (api.clGetDeviceInfo(device, CL_DEVICE_DOUBLE_FP_CONFIG, sizeof(fp64), &fp64, nullptr) != CL_SUCCESS || !fp64 || (fp64 & CL_FP_SOFT_FLOAT)) continue;
                api.clGetDeviceInfo(device, CL_DEVICE_AVAILABLE, sizeof(available), &available, nullptr);
                api.clGetDeviceInfo(device, CL_DEVICE_COMPILER_AVAILABLE, sizeof(compiler), &compiler, nullptr);
                api.clGetDeviceInfo(device, CL_DEVICE_MAX_COMPUTE_UNITS, sizeof(units), &units, nullptr);
                if (api.clGetDeviceInfo(device, CL_DEVICE_NAME, sizeof(name), name, nullptr) != CL_SUCCESS) continue;
                if (!available || !compiler || (!filter.empty() && std::string(name).find(filter) == std::string::npos)) continue;
                if (!selected || units > bestUnits) { selected = device; bestUnits = units; deviceName = name; }
            }
        }
        if (!selected) throw std::runtime_error("no matching GPU with hardware FP64 and OpenCL compiler");
        cl_int error = CL_SUCCESS;
        context = api.clCreateContext(nullptr, 1, &selected, nullptr, nullptr, &error);
        Check(error, "create context");
        queue = api.clCreateCommandQueue(context, selected, 0, &error);
        Check(error, "create queue");
        program = api.clCreateProgramWithSource(context, 1, &kernelSource, nullptr, &error);
        Check(error, "create program");
        error = api.clBuildProgram(program, 1, &selected, "-cl-std=CL1.2", nullptr, nullptr);
        if (error != CL_SUCCESS) {
            char log[4096]{};
            api.clGetProgramBuildInfo(program, selected, CL_PROGRAM_BUILD_LOG, sizeof(log), log, nullptr);
            throw std::runtime_error(std::string("build kernels: ") + log);
        }
        stiffness = api.clCreateKernel(program, "stiffness", &error); Check(error, "create stiffness kernel");
        strainStress = api.clCreateKernel(program, "strainStress", &error); Check(error, "create stress kernel");
        input = api.clCreateBuffer(context, CL_MEM_READ_ONLY, batchCapacity*9*sizeof(double), nullptr, &error); Check(error, "input buffer");
        output = api.clCreateBuffer(context, CL_MEM_WRITE_ONLY, batchCapacity*36*sizeof(double), nullptr, &error); Check(error, "output buffer");
        displacement = api.clCreateBuffer(context, CL_MEM_READ_ONLY, batchCapacity*6*sizeof(double), nullptr, &error); Check(error, "displacement buffer");
    }
    std::vector<double> Run(const std::vector<GpuElementInput>& inputs,
                           const std::vector<ElementDisplacementVector>* u) {
        const std::size_t width = u ? 8 : 36;
        std::vector<double> result(inputs.size()*width);
        std::vector<double> packed(batchCapacity*9), displacements(batchCapacity*6);
        cl_kernel kernel = u ? strainStress : stiffness;
        Check(api.clSetKernelArg(kernel, 0, sizeof(input), &input), "input argument");
        Check(api.clSetKernelArg(kernel, 1, sizeof(output), &output), "output argument");
        if (u) Check(api.clSetKernelArg(kernel, 2, sizeof(displacement), &displacement), "displacement argument");
        for (std::size_t start=0; start<inputs.size(); start+=batchCapacity) {
            const std::size_t count = std::min(batchCapacity, inputs.size()-start);
            for (std::size_t i=0; i<count; ++i) {
                const auto& element = inputs[start+i];
                std::copy(element.coordinates.begin(), element.coordinates.end(), packed.begin()+i*9);
                packed[i*9+6]=element.poissonRatio; packed[i*9+7]=element.elasticModulus; packed[i*9+8]=element.area;
                if (u) std::copy_n((*u)[start+i].data(), 6, displacements.data()+i*6);
            }
            // Blocking transfers keep host memory alive even if a later operation fails.
            Check(api.clEnqueueWriteBuffer(queue, input, CL_TRUE, 0, count*9*sizeof(double), packed.data(), 0, nullptr, nullptr), "upload elements");
            if (u) Check(api.clEnqueueWriteBuffer(queue, displacement, CL_TRUE, 0, count*6*sizeof(double), displacements.data(), 0, nullptr, nullptr), "upload displacement");
            Check(api.clEnqueueNDRangeKernel(queue, kernel, 1, nullptr, &count, nullptr, 0, nullptr, nullptr), "execute elements");
            Check(api.clEnqueueReadBuffer(queue, output, CL_TRUE, 0, count*width*sizeof(double), result.data()+start*width, 0, nullptr, nullptr), "download results");
        }
        for (double value : result) if (!std::isfinite(value)) throw std::runtime_error("non-finite GPU result");
        return result;
    }
#endif
};

GpuElementBackend::GpuElementBackend(std::size_t count, const std::string& mode,
                                     const std::string& filter, const std::string& measuredMinimumElements) {
    if (mode == "cpu") { status_ = "CPU explicitly selected"; return; }
    if (!mode.empty() && mode != "auto" && mode != "gpu") { status_ = "CPU: invalid FEM_COMPUTE (use auto/cpu/gpu)"; return; }
    if (count == 0) { status_ = "CPU: empty model"; return; }
    if (mode != "gpu") {
        // Do not guess a crossover from element count. The RTX 4070 sweep found
        // none up to ~1M elements, including a retained-context diagnostic.
        // Other machines may opt into an independently measured threshold.
        if (measuredMinimumElements.empty()) {
            status_ = "CPU: no validated GPU crossover"; return;
        }
        std::size_t threshold = 0;
        const auto parsed = std::from_chars(measuredMinimumElements.data(),
            measuredMinimumElements.data()+measuredMinimumElements.size(), threshold);
        if (parsed.ec != std::errc{} || parsed.ptr != measuredMinimumElements.data()+measuredMinimumElements.size() || threshold == 0) {
            status_ = "CPU: invalid FEM_GPU_MIN_ELEMENTS (use a positive measured threshold)"; return;
        }
        if (count < threshold) { status_ = "CPU: small model (<"+std::to_string(threshold)+" elements)"; return; }
    }
#ifdef _WIN32
    try {
        auto candidate = std::make_unique<State>();
        candidate->Initialize(filter);
        status_ = "OpenCL FP64: " + candidate->deviceName;
        state_ = std::move(candidate);
    } catch (const std::exception& error) { status_ = std::string("CPU fallback: ") + error.what(); }
#else
    (void)filter;
    status_ = "CPU: optional OpenCL backend currently supports Windows";
#endif
}
GpuElementBackend::~GpuElementBackend() = default;
bool GpuElementBackend::Available() const { return state_ != nullptr; }

bool GpuElementBackend::Stiffness(const std::vector<GpuElementInput>& inputs,
                                 std::vector<ElementStiffnessMatrix>& output) {
    if (!state_) return false;
#ifdef _WIN32
    try {
        const auto packed = state_->Run(inputs, nullptr);
        std::vector<ElementStiffnessMatrix> candidate(inputs.size());
        for (std::size_t i=0; i<inputs.size(); ++i)
            for (int r=0; r<6; ++r) for (int c=0; c<6; ++c) candidate[i](r,c)=packed[i*36+r*6+c];
        // Validate representative results before publishing a GPU batch.
        if (!inputs.empty()) for (const auto i : {std::size_t(0), inputs.size()/2, inputs.size()-1}) {
            const auto& e = inputs[i]; const auto& c = e.coordinates;
            const auto reference = CalculateElementStiffness(c[0],c[1],c[2],c[3],c[4],c[5],e.poissonRatio,e.elasticModulus,e.area);
            if (!candidate[i].isApprox(reference, 1e-11)) throw std::runtime_error("stiffness CPU reference check failed");
        }
        output.swap(candidate);
        return true;
    } catch (const std::exception& error) {
        status_ = std::string("CPU fallback: stiffness: ") + error.what(); state_.reset();
    }
#else
    (void)inputs; (void)output;
#endif
    return false;
}
bool GpuElementBackend::StrainStress(const std::vector<GpuElementInput>& inputs,
                                    const std::vector<ElementDisplacementVector>& u,
                                    std::vector<StrainStressMatrix>& output) {
    if (!state_) return false;
#ifdef _WIN32
    try {
        if (u.size() != inputs.size()) throw std::runtime_error("displacement count mismatch");
        const auto packed = state_->Run(inputs, &u);
        std::vector<StrainStressMatrix> candidate(inputs.size());
        for (std::size_t i=0; i<inputs.size(); ++i)
            for (int r=0; r<2; ++r) for (int c=0; c<4; ++c) candidate[i](r,c)=packed[i*8+r*4+c];
        if (!inputs.empty()) for (const auto i : {std::size_t(0), inputs.size()/2, inputs.size()-1}) {
            const auto& e = inputs[i]; const auto& c = e.coordinates;
            const auto reference = CalculateElementStrainStress(c[0],c[1],c[2],c[3],c[4],c[5],e.poissonRatio,e.elasticModulus,e.area,u[i]);
            if (!candidate[i].block<2,2>(0,0).isApprox(reference.block<2,2>(0,0), 1e-10) ||
                !candidate[i].block<2,2>(0,2).isApprox(reference.block<2,2>(0,2), 1e-10))
                throw std::runtime_error("strain/stress CPU reference check failed");
        }
        output.swap(candidate);
        return true;
    } catch (const std::exception& error) {
        status_ = std::string("CPU fallback: stress: ") + error.what(); state_.reset();
    }
#else
    (void)inputs; (void)u; (void)output;
#endif
    return false;
}
} // namespace fem
