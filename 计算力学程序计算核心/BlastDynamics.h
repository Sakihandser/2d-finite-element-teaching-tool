#pragma once
#include "CalculationData.h"
#include <iosfwd>
namespace fem {
// --blast-ipc: same FEMBIN01 model, followed by numeric command-line settings.
int RunBlastDynamics(const CalculationModel& model, int argc, char* argv[], std::ostream& output);
}
