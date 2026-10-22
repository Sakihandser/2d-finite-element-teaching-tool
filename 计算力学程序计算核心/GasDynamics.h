#pragma once
#include <vector>
#include <cstddef>

namespace fem {
// Conservative radial HLLC/Godunov with material-interface-preserving rezoning.
// Products are fully reacted at t=0; no finite-rate burn law.
struct GasParameters {
  int cells=192, geometry=2; // 1: planar verification, 2: cylindrical/unit depth
  double radius=.1, chargeRadius=.05;
  double productDensity=1000, productEnergy=1e6;
  double A=0, B=0, R1=4.5, R2=1.1, omega=.3;
  double airDensity=1.2, airPressure=101325, airGamma=1.4;
};
struct GasThermodynamics { double pressure=0, soundSpeedSquared=0; };
struct GasSnapshot {
  double internalEnergy=0, kineticEnergy=0, wallWork=0, wallPressure=0, radius=0;
  std::size_t substeps=0, rezones=0;
  double productMass=0, airMass=0;
};
class GasDynamics {
public:
  explicit GasDynamics(const GasParameters& parameters);
  static GasThermodynamics ProductsEOS(const GasParameters&,double density,double energy);
  // Evolve up to targetTime, imposing a wall volume that changes linearly over
  // this call. Returns time-integrated pressure / interval for impulse loading.
  double Advance(double targetTime,double wallRadius);
  GasSnapshot Snapshot() const;
  double WallPressure() const;
  const std::vector<double>& Positions() const {return position;}
  const std::vector<double>& Velocities() const {return velocity;}
  std::vector<double> Densities() const;
  std::vector<double> Pressures() const;
  double InitialEnergy() const {return initialEnergy;}
private:
  struct State {const std::vector<double>& r;const std::vector<double>& v;const std::vector<double>& e;};
  struct Material {std::vector<double> p,c,rho;};
  GasParameters settings;
  std::vector<double> position,velocity,energy,mass;
  std::vector<double> nextPosition,nextVelocity,nextEnergy;
  std::vector<bool> products;
  double time=0,wallWork=0,initialEnergy=0,wallVelocity=0;
  std::size_t substeps=0, rezones=0;
  double Volume(double radius) const;
  double Area(double radius) const;
  Material Evaluate(const State&) const;
  double StableStep(const State&,const Material&) const;
  double Step(double dt,double wallRadius,const Material&);
  void Rezone();
};
}
