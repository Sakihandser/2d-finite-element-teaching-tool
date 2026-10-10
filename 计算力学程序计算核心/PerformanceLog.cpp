#include "PerformanceLog.h"

#include <algorithm>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace fem {
namespace {

std::tm LocalTime(std::time_t value) {
  std::tm result{};
#ifdef _WIN32
  localtime_s(&result, &value);
#else
  localtime_r(&value, &result);
#endif
  return result;
}

std::string FormatWallTime(const std::chrono::system_clock::time_point& value) {
  const std::time_t seconds = std::chrono::system_clock::to_time_t(value);
  const std::tm localTime = LocalTime(seconds);
  const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(
      value.time_since_epoch()) % 1000;

  std::ostringstream stream;
  stream << std::put_time(&localTime, "%Y-%m-%d %H:%M:%S")
         << '.' << std::setfill('0') << std::setw(3) << millis.count();
  return stream.str();
}

std::string FilenameTimestamp(const std::chrono::system_clock::time_point& value) {
  const std::time_t seconds = std::chrono::system_clock::to_time_t(value);
  const std::tm localTime = LocalTime(seconds);
  const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(
      value.time_since_epoch()) % 1000;

  std::ostringstream stream;
  stream << std::put_time(&localTime, "%Y%m%d-%H%M%S")
         << '-' << std::setfill('0') << std::setw(3) << millis.count();
  return stream.str();
}

double Milliseconds(PerformanceLog::Duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

bool IsCoreProjectDirectory(const std::filesystem::path& path) {
  return std::filesystem::exists(path / std::filesystem::u8path(u8"计算力学程序计算核心.vcxproj"));
}

}  // namespace

PerformanceLog::PerformanceLog()
    : startedAt_(Clock::now()), wallStartedAt_(std::chrono::system_clock::now()) {}

PerformanceLog::~PerformanceLog() {
  if (written_) {
    return;
  }
  try {
    const auto path = Write();
    std::cout << "Performance log written to: " << path.u8string() << '\n';
  } catch (const std::exception& error) {
    std::cerr << "Failed to write performance log: " << error.what() << '\n';
  }
}

PerformanceLog::TimePoint PerformanceLog::Now() {
  return Clock::now();
}

void PerformanceLog::AddTiming(const std::string& stage, TimePoint startedAt, std::uint64_t calls) {
  AddDuration(stage, Clock::now() - startedAt, calls);
}

void PerformanceLog::AddDuration(const std::string& stage, Duration duration, std::uint64_t calls) {
  const auto found = std::find_if(timings_.begin(), timings_.end(), [&](const TimingEntry& entry) {
    return entry.stage == stage;
  });
  if (found == timings_.end()) {
    timings_.push_back({stage, duration, calls});
    return;
  }
  found->duration += duration;
  found->calls += calls;
}

void PerformanceLog::SetDetail(const std::string& name, const std::string& value) {
  const auto found = std::find_if(details_.begin(), details_.end(), [&](const auto& detail) {
    return detail.first == name;
  });
  if (found == details_.end()) {
    details_.emplace_back(name, value);
  } else {
    found->second = value;
  }
}

void PerformanceLog::SetLogRootHint(const std::filesystem::path& sourceInputPath) {
  sourceInputPath_ = sourceInputPath;
}

void PerformanceLog::MarkSuccess() {
  status_ = "成功";
  statusMessage_.clear();
}

void PerformanceLog::MarkFailure(const std::string& message) {
  status_ = "失败";
  statusMessage_ = message;
}

std::filesystem::path PerformanceLog::FindLogDirectory() const {
  // calculation-data 与计算核心目录位于同一项目根目录下，优先使用这个稳定关系。
  if (!sourceInputPath_.empty()) {
    const auto projectRoot = sourceInputPath_.parent_path().parent_path();
    const auto coreDirectory = projectRoot / std::filesystem::u8path(u8"计算力学程序计算核心");
    if (IsCoreProjectDirectory(coreDirectory)) {
      return coreDirectory / "log";
    }
  }

  // 兼容从项目根目录、计算核心目录和 Visual Studio 输出目录直接启动。
  std::filesystem::path cursor = std::filesystem::current_path();
  for (int depth = 0; depth < 8 && !cursor.empty(); ++depth) {
    if (IsCoreProjectDirectory(cursor)) {
      return cursor / "log";
    }
    const auto nestedCore = cursor / std::filesystem::u8path(u8"计算力学程序计算核心");
    if (IsCoreProjectDirectory(nestedCore)) {
      return nestedCore / "log";
    }
    if (cursor == cursor.parent_path()) {
      break;
    }
    cursor = cursor.parent_path();
  }

  return std::filesystem::current_path() / "log";
}

std::filesystem::path PerformanceLog::Write() {
  if (written_) {
    return outputPath_;
  }

  const auto finishedAt = Clock::now();
  const auto wallFinishedAt = std::chrono::system_clock::now();
  const Duration totalDuration = finishedAt - startedAt_;
  const double totalMilliseconds = Milliseconds(totalDuration);

  const auto logDirectory = FindLogDirectory();
  std::filesystem::create_directories(logDirectory);

  const std::string baseName = "performance-" + FilenameTimestamp(wallStartedAt_);
  outputPath_ = logDirectory / (baseName + ".txt");
  for (int suffix = 1; std::filesystem::exists(outputPath_); ++suffix) {
    outputPath_ = logDirectory / (baseName + "-" + std::to_string(suffix) + ".txt");
  }

  std::ofstream output(outputPath_);
  if (!output) {
    throw std::runtime_error("Cannot open performance log file: " + outputPath_.u8string());
  }

  Duration measuredDuration{};
  for (const auto& entry : timings_) {
    measuredDuration += entry.duration;
  }
  const Duration unclassifiedDuration = totalDuration > measuredDuration
      ? totalDuration - measuredDuration
      : Duration::zero();

  output << "有限元计算性能分析日志\n";
  output << "============================================================\n";
  output << "开始时间: " << FormatWallTime(wallStartedAt_) << '\n';
  output << "结束时间: " << FormatWallTime(wallFinishedAt) << '\n';
  output << "运行状态: " << status_ << '\n';
  if (!statusMessage_.empty()) {
    output << "状态说明: " << statusMessage_ << '\n';
  }
  output << std::fixed << std::setprecision(3);
  output << "程序总耗时: " << totalMilliseconds << " ms\n\n";

  output << "[模型与运行信息]\n";
  if (details_.empty()) {
    output << "(尚未读取到模型信息)\n";
  } else {
    for (const auto& detail : details_) {
      output << detail.first << ": " << detail.second << '\n';
    }
  }

  auto writeTimingHeader = [&]() {
    // 使用制表符，避免 UTF-8 中文按字节计宽造成列粘连，也便于直接粘贴到表格软件。
    output << "阶段\t总耗时(ms)\t占总时长\t调用次数\t平均(us/次)\n";
    output << std::string(88, '-') << '\n';
  };

  auto writeTiming = [&](const TimingEntry& entry) {
    const double durationMs = Milliseconds(entry.duration);
    const double percentage = totalMilliseconds > 0.0 ? durationMs * 100.0 / totalMilliseconds : 0.0;
    const double averageUs = entry.calls > 0
        ? durationMs * 1000.0 / static_cast<double>(entry.calls)
        : 0.0;
    std::ostringstream percentText;
    percentText << std::fixed << std::setprecision(2) << percentage << '%';
    output << entry.stage << '\t'
           << std::fixed << std::setprecision(3) << durationMs << '\t'
           << percentText.str() << '\t'
           << entry.calls << '\t'
           << std::fixed << std::setprecision(3) << averageUs << '\n';
  };

  output << "\n[按执行顺序的阶段耗时]\n";
  writeTimingHeader();
  for (const auto& entry : timings_) {
    writeTiming(entry);
  }
  writeTiming({"未归类流程及计时开销", unclassifiedDuration, 1});

  std::vector<TimingEntry> rankedTimings = timings_;
  rankedTimings.push_back({"未归类流程及计时开销", unclassifiedDuration, 1});
  std::stable_sort(rankedTimings.begin(), rankedTimings.end(), [](const auto& left, const auto& right) {
    return left.duration > right.duration;
  });

  output << "\n[耗时排名（由高到低）]\n";
  writeTimingHeader();
  for (const auto& entry : rankedTimings) {
    writeTiming(entry);
  }

  output << "\n[说明]\n";
  output << "1. 百分比以程序总墙钟时间为基准；各已记录阶段互不嵌套。\n";
  output << "2. 单元批处理阶段记录整个串行或并行循环的墙钟时间，调用次数等于本次处理的单元数。\n";
  output << "3. “未归类流程及计时开销”包含阶段切换、对象构造、日志统计本身等零散耗时。\n";
  output << "4. 性能比较应优先使用 Release|x64，并对同一模型连续运行多次。\n";
  output << "END\n";

  if (!output) {
    throw std::runtime_error("Failed while writing performance log file: " + outputPath_.u8string());
  }

  written_ = true;
  return outputPath_;
}

}  // namespace fem
