#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

namespace fem {

// 收集一次有限元计算中的模型规模和分阶段耗时，并在程序结束时写入 log 目录。
// 计时使用 steady_clock，不受系统时间校准影响；日志时间戳使用 system_clock。
class PerformanceLog {
 public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;
  using Duration = Clock::duration;

  PerformanceLog();
  ~PerformanceLog();

  PerformanceLog(const PerformanceLog&) = delete;
  PerformanceLog& operator=(const PerformanceLog&) = delete;

  static TimePoint Now();

  // 记录一次完整阶段，calls 用于计算单次平均耗时。
  void AddTiming(const std::string& stage, TimePoint startedAt, std::uint64_t calls = 1);
  void AddDuration(const std::string& stage, Duration duration, std::uint64_t calls = 1);

  // 记录日志中“模型与运行信息”段的键值。
  void SetDetail(const std::string& name, const std::string& value);
  void SetLogRootHint(const std::filesystem::path& sourceInputPath);

  void MarkSuccess();
  void MarkFailure(const std::string& message);

  // 可显式写日志；若未调用，析构函数仍会自动写出失败/未完成日志。
  std::filesystem::path Write();

 private:
  struct TimingEntry {
    std::string stage;
    Duration duration{};
    std::uint64_t calls = 0;
  };

  std::filesystem::path FindLogDirectory() const;

  TimePoint startedAt_;
  std::chrono::system_clock::time_point wallStartedAt_;
  std::vector<TimingEntry> timings_;
  std::vector<std::pair<std::string, std::string>> details_;
  std::filesystem::path sourceInputPath_;
  std::filesystem::path outputPath_;
  std::string status_ = "未完成或提前退出";
  std::string statusMessage_;
  bool written_ = false;
};

}  // namespace fem
