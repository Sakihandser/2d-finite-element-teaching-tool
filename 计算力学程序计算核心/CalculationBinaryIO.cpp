#include "CalculationBinaryIO.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace fem {
namespace {

constexpr std::array<char, 8> kInputMagic = {'F', 'E', 'M', 'B', 'I', 'N', '0', '1'};
constexpr std::array<char, 8> kResultMagic = {'F', 'E', 'M', 'R', 'E', 'S', '1', '\0'};
constexpr std::uint32_t kProtocolVersion = 1;
constexpr std::uint32_t kMaximumRecordCount = 20'000'000;
constexpr std::uint32_t kMaximumStringBytes = 16 * 1024 * 1024;

class BinaryReader {
 public:
  explicit BinaryReader(const std::vector<char>& input)
      : cursor_(input.data()), end_(input.data() + input.size()) {}

  template <typename T>
  T Read() {
    static_assert(std::is_trivially_copyable_v<T>);
    T value{};
    ReadBytes(reinterpret_cast<char*>(&value), sizeof(value));
    return value;
  }

  std::string ReadString() {
    const std::uint32_t byteCount = Read<std::uint32_t>();
    if (byteCount > kMaximumStringBytes) {
      throw std::runtime_error("Binary FEM string is too large.");
    }
    std::string value(byteCount, '\0');
    if (byteCount != 0) {
      ReadBytes(value.data(), byteCount);
    }
    return value;
  }

  std::uint32_t ReadCount(const char* name) {
    const std::uint32_t value = Read<std::uint32_t>();
    if (value > kMaximumRecordCount) {
      throw std::runtime_error(std::string("Binary FEM ") + name + " count is too large.");
    }
    return value;
  }

  void ExpectMagic(const std::array<char, 8>& expected) {
    std::array<char, 8> actual{};
    ReadBytes(actual.data(), actual.size());
    if (actual != expected) {
      throw std::runtime_error("Unsupported binary FEM input header.");
    }
  }

 private:
  void ReadBytes(char* destination, std::size_t byteCount) {
    if (byteCount > static_cast<std::size_t>(end_ - cursor_)) {
      throw std::runtime_error("Unexpected end of binary FEM input.");
    }
    std::memcpy(destination, cursor_, byteCount);
    cursor_ += byteCount;
  }

  const char* cursor_;
  const char* end_;
};

class BinaryWriter {
 public:
  explicit BinaryWriter(std::size_t expectedBytes) {
    data_.reserve(expectedBytes);
  }

  template <typename T>
  void Write(const T& value) {
    static_assert(std::is_trivially_copyable_v<T>);
    WriteBytes(reinterpret_cast<const char*>(&value), sizeof(value));
  }

  void WriteMagic(const std::array<char, 8>& value) {
    WriteBytes(value.data(), value.size());
  }

  void Flush(std::ostream& output) {
    output.write(data_.data(), static_cast<std::streamsize>(data_.size()));
    if (!output) {
      throw std::runtime_error("Failed while writing binary FEM result.");
    }
    output.flush();
    if (!output) {
      throw std::runtime_error("Failed while flushing binary FEM result.");
    }
  }

 private:
  void WriteBytes(const char* data, std::size_t byteCount) {
    const std::size_t oldSize = data_.size();
    data_.resize(oldSize + byteCount);
    std::memcpy(data_.data() + oldSize, data, byteCount);
  }

  std::vector<char> data_;
};

int CheckedInt(std::int32_t value, const char* name) {
  if (value < 0) {
    throw std::runtime_error(std::string("Binary FEM ") + name + " cannot be negative.");
  }
  return static_cast<int>(value);
}

double DisplacementValue(const Eigen::VectorXd& displacement, int dofNumber) {
  if (dofNumber <= 0 || dofNumber > displacement.size()) {
    throw std::runtime_error("Binary FEM result references an invalid displacement DOF.");
  }
  return displacement(dofNumber - 1);
}

int ResultIndex(int elementNo, Eigen::Index resultSize) {
  const int index = elementNo - 1;
  if (index < 0 || index >= resultSize) {
    throw std::runtime_error("Binary FEM result references an invalid element index.");
  }
  return index;
}

}  // namespace

void ConfigureBinaryStandardStreams() {
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) {
    throw std::runtime_error("Cannot configure binary standard streams.");
  }
#endif
}

CalculationModel LoadCalculationModelBinary(std::istream& input) {
  static_assert(sizeof(double) == 8, "The binary FEM protocol requires IEEE-754 64-bit doubles.");
  static_assert(sizeof(std::int32_t) == 4, "The binary FEM protocol requires 32-bit integers.");

  std::vector<char> inputBytes;
  inputBytes.reserve(2 * 1024 * 1024);
  std::vector<char> inputChunk(1024 * 1024);
  while (input) {
    input.read(inputChunk.data(), static_cast<std::streamsize>(inputChunk.size()));
    const std::streamsize bytesRead = input.gcount();
    if (bytesRead > 0) {
      inputBytes.insert(inputBytes.end(), inputChunk.data(), inputChunk.data() + bytesRead);
    }
  }
  if (input.bad()) {
    throw std::runtime_error("Failed while reading binary FEM input pipe.");
  }

  BinaryReader reader(inputBytes);
  reader.ExpectMagic(kInputMagic);
  if (reader.Read<std::uint32_t>() != kProtocolVersion) {
    throw std::runtime_error("Unsupported binary FEM protocol version.");
  }

  CalculationModel model;
  model.header = "FEM_CALCULATION_BINARY_V1";
  model.modelName = reader.ReadString();
  model.generatedAt = reader.ReadString();
  model.units.length = reader.ReadString();
  model.units.force = reader.ReadString();
  model.units.elasticModulus = reader.ReadString();
  model.units.density = reader.ReadString();
  model.units.strength = reader.ReadString();

  model.counts.nodes = CheckedInt(reader.Read<std::int32_t>(), "node count");
  model.counts.elements = CheckedInt(reader.Read<std::int32_t>(), "element count");
  model.counts.materials = CheckedInt(reader.Read<std::int32_t>(), "material count");
  model.counts.pointLoads = CheckedInt(reader.Read<std::int32_t>(), "point load count");
  model.counts.distributedLoads = CheckedInt(reader.Read<std::int32_t>(), "distributed load count");
  model.counts.bodyLoads = CheckedInt(reader.Read<std::int32_t>(), "body load count");

  const std::uint32_t materialCount = reader.ReadCount("material");
  const std::uint32_t nodeCount = reader.ReadCount("node");
  const std::uint32_t elementCount = reader.ReadCount("element");
  const std::uint32_t elementLoadCount = reader.ReadCount("element load");
  model.materials.reserve(materialCount);
  model.nodes.reserve(nodeCount);
  model.elements.reserve(elementCount);
  model.elementNodeLoads.reserve(elementLoadCount);

  for (std::uint32_t i = 0; i < materialCount; ++i) {
    MaterialData material;
    material.materialNo = reader.Read<std::int32_t>();
    material.elasticModulus = reader.Read<double>();
    material.poissonRatio = reader.Read<double>();
    material.density = reader.Read<double>();
    material.yieldStrength = reader.Read<double>();
    material.tensileStrength = reader.Read<double>();
    material.compressiveStrength = reader.Read<double>();
    model.materials.push_back(material);
  }

  for (std::uint32_t i = 0; i < nodeCount; ++i) {
    NodeData node;
    node.nodeNo = reader.Read<std::int32_t>();
    node.x = reader.Read<double>();
    node.y = reader.Read<double>();
    node.fixUx = reader.Read<std::uint8_t>() != 0;
    node.fixUy = reader.Read<std::uint8_t>() != 0;
    node.dofUx = reader.Read<std::int32_t>();
    node.dofUy = reader.Read<std::int32_t>();
    node.forceX = reader.Read<double>();
    node.forceY = reader.Read<double>();
    node.materialNo = reader.Read<std::int32_t>();
    node.regionNo = reader.Read<std::int32_t>();
    model.nodes.push_back(node);
  }

  for (std::uint32_t i = 0; i < elementCount; ++i) {
    ElementData element;
    element.elementNo = reader.Read<std::int32_t>();
    element.node1 = reader.Read<std::int32_t>();
    element.node2 = reader.Read<std::int32_t>();
    element.node3 = reader.Read<std::int32_t>();
    element.area = reader.Read<double>();
    element.centroidX = reader.Read<double>();
    element.centroidY = reader.Read<double>();
    element.materialNo = reader.Read<std::int32_t>();
    element.elasticModulus = reader.Read<double>();
    element.poissonRatio = reader.Read<double>();
    element.density = reader.Read<double>();
    element.yieldStrength = reader.Read<double>();
    element.tensileStrength = reader.Read<double>();
    element.compressiveStrength = reader.Read<double>();
    model.elements.push_back(element);
  }

  for (std::uint32_t i = 0; i < elementLoadCount; ++i) {
    ElementNodeLoadData load;
    load.elementNo = reader.Read<std::int32_t>();
    load.forceX1 = reader.Read<double>();
    load.forceY1 = reader.Read<double>();
    load.forceX2 = reader.Read<double>();
    load.forceY2 = reader.Read<double>();
    load.forceX3 = reader.Read<double>();
    load.forceY3 = reader.Read<double>();
    model.elementNodeLoads.push_back(load);
  }

  const std::uint32_t warningCount = reader.ReadCount("warning");
  model.fileWarnings.reserve(warningCount);
  for (std::uint32_t i = 0; i < warningCount; ++i) {
    model.fileWarnings.push_back(reader.ReadString());
  }

  ValidateCalculationModel(model);
  return model;
}

void WriteCalculationResultBinary(
    std::ostream& output,
    const CalculationModel& model,
    const Eigen::VectorXd& nodeDisplacement,
    const std::vector<Eigen::Matrix2d>& elementStrain,
    const std::vector<Eigen::Matrix2d>& elementStress,
    const Eigen::VectorXi& securityCheckList) {
  if (model.nodes.size() > std::numeric_limits<std::uint32_t>::max() ||
      model.elements.size() > std::numeric_limits<std::uint32_t>::max()) {
    throw std::runtime_error("Binary FEM result contains too many records.");
  }

  const std::size_t expectedBytes = 20 + model.nodes.size() * 28 + model.elements.size() * 72;
  BinaryWriter writer(expectedBytes);
  writer.WriteMagic(kResultMagic);
  writer.Write(kProtocolVersion);
  writer.Write(static_cast<std::uint32_t>(model.nodes.size()));
  writer.Write(static_cast<std::uint32_t>(model.elements.size()));

  for (const auto& node : model.nodes) {
    const double ux = DisplacementValue(nodeDisplacement, node.dofUx);
    const double uy = DisplacementValue(nodeDisplacement, node.dofUy);
    writer.Write(static_cast<std::int32_t>(node.nodeNo));
    writer.Write(ux);
    writer.Write(uy);
    writer.Write(std::hypot(ux, uy));
  }

  for (const auto& element : model.elements) {
    const int index = ResultIndex(element.elementNo, securityCheckList.size());
    if (index >= static_cast<int>(elementStrain.size()) || index >= static_cast<int>(elementStress.size())) {
      throw std::runtime_error("Binary FEM result tensor index is out of range.");
    }
    const Eigen::Matrix2d& strain = elementStrain[static_cast<std::size_t>(index)];
    const Eigen::Matrix2d& stress = elementStress[static_cast<std::size_t>(index)];
    writer.Write(static_cast<std::int32_t>(element.elementNo));
    const double values[] = {
        strain(0, 0), strain(0, 1), strain(1, 0), strain(1, 1),
        stress(0, 0), stress(0, 1), stress(1, 0), stress(1, 1)};
    for (double value : values) {
      writer.Write(value);
    }
    writer.Write(static_cast<std::int32_t>(securityCheckList(index)));
  }
  writer.Flush(output);
}

}  // namespace fem
