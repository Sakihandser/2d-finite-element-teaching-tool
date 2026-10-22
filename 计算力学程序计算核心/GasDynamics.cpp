// HLLC contact speed/star pressure adapted from Clawpack Riemann euler_1D_py.py,
// commit b0d609c3c0fe16a1967ad53cbbc46d43f92c3a25.
// Copyright (c) 1994-2018 Clawpack Developers, BSD-3-Clause;
// see ../third_party/clawpack-riemann/LICENSE. General-EOS wave speeds,
// material-following radial control volumes and wall coupling are application additions.
// JWL reference pressure, reference energy and bulk modulus adapted from LANL
// Singularity-EOS eos_jwl.hpp, b4f71a7748770dfa6ce4d678754c463c09262fb7.
// Copyright (c) 2021-2026 Triad National Security, LLC. BSD-3-Clause;
// see ../third_party/singularity-eos/LICENSE and the retained source header.
#include "GasDynamics.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace fem {
namespace {
constexpr double pi=3.14159265358979323846;
void Check(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
struct Contact {double velocity,pressure;};
Contact HLLC(double rhoL,double uL,double pL,double cL,double rhoR,double uR,double pR,double cR) {
  const double sL=std::min(uL-cL,uR-cR),sR=std::max(uL+cL,uR+cR);
  const double left=rhoL*(sL-uL),right=rhoR*(sR-uR);
  const double speed=(pR-pL+left*uL-right*uR)/(left-right);
  const double pressure=.5*(pL+left*(speed-uL)+pR+right*(speed-uR));
  Check(std::isfinite(speed) && std::isfinite(pressure) && pressure>0,"Gas Riemann state reached vacuum/nonpositive pressure.");
  return {speed,pressure};
}
}
GasThermodynamics GasDynamics::ProductsEOS(const GasParameters& p,double rho,double e) {
  Check(rho>0 && e>0 && std::isfinite(rho) && std::isfinite(e),"Nonpositive gas density/internal energy.");
  const double x=p.productDensity/rho;
  const double a=p.A*std::exp(-p.R1*x),b=p.B*std::exp(-p.R2*x);
  const double referenceEnergy=a/(p.productDensity*p.R1)+b/(p.productDensity*p.R2);
  const double thermalPressure=p.omega*rho*(e-referenceEnergy);
  const double pressure=a+b+thermalPressure;
  const double bulk=(p.omega+1)*thermalPressure+x*(p.R1*a+p.R2*b);
  return {pressure,bulk/rho};
}
double GasDynamics::Volume(double r) const{return settings.geometry==2 ? pi*r*r : r;}
double GasDynamics::Area(double r) const{return settings.geometry==2 ? 2*pi*r : 1.;}
GasDynamics::GasDynamics(const GasParameters& p):settings(p) {
  Check(p.cells>=16 && p.cells<=2048 && (p.geometry==1 || p.geometry==2),"Invalid radial gas resolution/geometry.");
  Check(p.radius>0 && p.chargeRadius>0 && p.chargeRadius<=p.radius*(1+1e-8),"Charge must fit inside gas cavity.");
  Check(p.productDensity>0 && p.productEnergy>0 && p.A>=0 && p.B>=0 && p.R1>0 && p.R2>0 && p.omega>0 && p.omega<=9,
    "Invalid products/JWL material parameters.");
  Check(p.airDensity>0 && p.airPressure>0 && p.airGamma>1 && p.airGamma<=2,"Invalid air material parameters.");
  const bool gap=p.chargeRadius<p.radius*(1-1e-8);
  const int productCells=gap ? std::clamp(static_cast<int>(std::round(p.cells*p.chargeRadius/p.radius)),4,p.cells-4) : p.cells;
  position.resize(p.cells+1);velocity.assign(p.cells,0);energy.resize(p.cells);mass.resize(p.cells);products.resize(p.cells);
  nextPosition.resize(p.cells+1);nextVelocity.resize(p.cells);nextEnergy.resize(p.cells);
  for(int i=0;i<=p.cells;++i)position[i]=i<=productCells ? p.chargeRadius*i/productCells
    : p.chargeRadius+(p.radius-p.chargeRadius)*(i-productCells)/(p.cells-productCells);
  position.back()=p.radius;
  for(int i=0;i<p.cells;++i){
    products[i]=i<productCells;
    const double rho=products[i] ? p.productDensity : p.airDensity;
    mass[i]=rho*(Volume(position[i+1])-Volume(position[i]));
    energy[i]=products[i] ? p.productEnergy : p.airPressure/((p.airGamma-1)*p.airDensity);
  }
  Evaluate({position,velocity,energy});initialEnergy=Snapshot().internalEnergy;
}
GasDynamics::Material GasDynamics::Evaluate(const State& state) const {
  const std::size_t n=mass.size();Material material;material.p.resize(n);material.c.resize(n);material.rho.resize(n);
  for(std::size_t i=0;i<n;++i){
    const double h=state.r[i+1]-state.r[i],volume=Volume(state.r[i+1])-Volume(state.r[i]);
    Check(h>0 && volume>0 && state.e[i]>0 && std::isfinite(state.e[i]),"Gas mesh inverted or internal energy became nonpositive.");
    const double rho=mass[i]/volume;
    const auto eos=products[i] ? ProductsEOS(settings,rho,state.e[i])
      : GasThermodynamics{(settings.airGamma-1)*rho*state.e[i],settings.airGamma*(settings.airGamma-1)*state.e[i]};
    Check(eos.pressure>0 && eos.soundSpeedSquared>0 && std::isfinite(eos.pressure) && std::isfinite(eos.soundSpeedSquared),
      "Gas EOS left its positive-pressure/hyperbolic domain; check material parameters.");
    material.p[i]=eos.pressure;material.c[i]=std::sqrt(eos.soundSpeedSquared);material.rho[i]=rho;
  }
  return material;
}
double GasDynamics::StableStep(const State& state,const Material& material) const {
  double dt=std::numeric_limits<double>::infinity();
  for(std::size_t i=0;i<mass.size();++i){
    dt=std::min(dt,.25*(state.r[i+1]-state.r[i])/(material.c[i]+std::abs(state.v[i])));
  }
  return dt;
}
double GasDynamics::Step(double dt,double nextWall,const Material& state) {
  const std::size_t n=mass.size();
  const double imposed=(nextWall-position.back())/dt;
  std::vector<Contact> face(n+1);
  face[0]=HLLC(state.rho[0],-velocity[0],state.p[0],state.c[0],state.rho[0],velocity[0],state.p[0],state.c[0]);
  face[0].velocity=0;
  for(std::size_t j=1;j<n;++j)face[j]=HLLC(state.rho[j-1],velocity[j-1],state.p[j-1],state.c[j-1],state.rho[j],velocity[j],state.p[j],state.c[j]);
  face[n]=HLLC(state.rho.back(),velocity.back(),state.p.back(),state.c.back(),state.rho.back(),2*imposed-velocity.back(),state.p.back(),state.c.back());
  face[n].velocity=imposed;
  nextPosition[0]=position[0];
  for(std::size_t j=1;j<=n;++j)nextPosition[j]=position[j]+dt*face[j].velocity;
  nextPosition[n]=nextWall;
  for(std::size_t i=0;i<n;++i){
    const double leftArea=Area(.5*(position[i]+nextPosition[i])),rightArea=Area(.5*(position[i+1]+nextPosition[i+1]));
    // The cylindrical momentum source p*dA cancels uniform pressure exactly.
    nextVelocity[i]=velocity[i]+dt*(leftArea*(face[i].pressure-state.p[i])-rightArea*(face[i+1].pressure-state.p[i]))/mass[i];
    const double total=energy[i]+.5*velocity[i]*velocity[i]+dt*
      (leftArea*face[i].pressure*face[i].velocity-rightArea*face[i+1].pressure*face[i+1].velocity)/mass[i];
    nextEnergy[i]=total-.5*nextVelocity[i]*nextVelocity[i];
  }
  Evaluate({nextPosition,nextVelocity,nextEnergy});
  wallWork+=face[n].pressure*(Volume(nextWall)-Volume(position.back()));
  position.swap(nextPosition);velocity.swap(nextVelocity);energy.swap(nextEnergy);wallVelocity=imposed;++substeps;
  return face[n].pressure;
}
void GasDynamics::Rezone() {
  // Integrate overlap in physical volume, separately in each material. The
  // material contact and wall stay fixed; mass, momentum and total energy are
  // conserved. This avoids vanishing Lagrangian cells after shock reflections.
  const std::size_t n=mass.size();
  std::size_t split=0;
  while(split<n && products[split])++split;
  std::size_t targetSplit=split;
  if(split<n) {
    const std::size_t desired=static_cast<std::size_t>(std::clamp(
      static_cast<int>(std::round(n*position[split]/position.back())),4,static_cast<int>(n)-4));
    // Reallocate resolution as the air annulus compresses. Hysteresis avoids
    // remapping at every small interface motion. Keep at least four cells in
    // each material and let that count grow with spatial refinement.
    if(split>2*desired || desired>2*split || n-split>2*(n-desired) || n-desired>2*(n-split))targetSplit=desired;
  }
  const bool reallocate=targetSplit!=split;
  bool needed=false;
  for(std::size_t begin=0;begin<n;) {
    std::size_t end=begin+1;
    while(end<n && products[end]==products[begin])++end;
    const double width=(position[end]-position[begin])/(end-begin);
    for(std::size_t i=begin;i<end;++i)
      if(position[i+1]-position[i]<.2*width){needed=true;break;}
    begin=end;
  }
  if(!needed && !reallocate)return;
  std::vector<double> r=position,m=mass,v=velocity,e=energy;
  std::vector<bool> nextProducts=products;
  for(std::size_t begin=0,targetBegin=0;begin<n;) {
    std::size_t end=begin+1;
    while(end<n && products[end]==products[begin])++end;
    const std::size_t targetEnd=end==split ? targetSplit : n;
    const double width=(position[end]-position[begin])/(targetEnd-targetBegin);
    bool crowded=reallocate;
    for(std::size_t i=begin;i<end;++i)
      if(position[i+1]-position[i]<.2*width){crowded=true;break;}
    if(crowded) {
      r[targetBegin]=position[begin];r[targetEnd]=position[end];
      for(std::size_t i=targetBegin+1;i<targetEnd;++i)r[i]=position[begin]+width*(i-targetBegin);
      std::size_t donor=begin;
      for(std::size_t i=targetBegin;i<targetEnd;++i) {
        double cellMass=0,momentum=0,totalEnergy=0;
        while(donor+1<end && position[donor+1]<=r[i])++donor;
        for(std::size_t j=donor;j<end && position[j]<r[i+1];++j) {
          const double left=std::max(position[j],r[i]),right=std::min(position[j+1],r[i+1]);
          if(right<=left)continue;
          const double portion=mass[j]*(Volume(right)-Volume(left))/(Volume(position[j+1])-Volume(position[j]));
          cellMass+=portion;momentum+=portion*velocity[j];
          totalEnergy+=portion*(energy[j]+.5*velocity[j]*velocity[j]);
        }
        m[i]=cellMass;v[i]=momentum/cellMass;e[i]=totalEnergy/cellMass-.5*v[i]*v[i];
        const double rho=cellMass/(Volume(r[i+1])-Volume(r[i]));
        nextProducts[i]=products[begin];
        const auto eos=nextProducts[i] ? ProductsEOS(settings,rho,e[i])
          : GasThermodynamics{(settings.airGamma-1)*rho*e[i],settings.airGamma*(settings.airGamma-1)*e[i]};
        Check(cellMass>0 && e[i]>0 && eos.pressure>0 && eos.soundSpeedSquared>0 &&
          std::isfinite(v[i]) && std::isfinite(e[i]) && std::isfinite(eos.pressure) && std::isfinite(eos.soundSpeedSquared),
          "Conservative gas rezoning left the physical EOS domain.");
      }
    }
    begin=end;targetBegin=targetEnd;
  }
  position.swap(r);mass.swap(m);velocity.swap(v);energy.swap(e);products.swap(nextProducts);++rezones;
}

double GasDynamics::Advance(double targetTime,double wallRadius) {
  Check(targetTime>time && wallRadius>0 && std::isfinite(wallRadius),"Invalid gas advance target.");
  const double start=time,initialVolume=Volume(position.back()),endVolume=Volume(wallRadius),interval=targetTime-start;
  double impulse=0;
  while(time<targetTime){
    // Runtime is bounded by the caller's wall-clock limit. A cumulative step
    // cap rejects legitimate refined meshes; collapse/no-progress checks below
    // detect a stalled solver without imposing a resolution-dependent cutoff.
    const State state{position,velocity,energy};const auto material=Evaluate(state);
    double dt=std::min(targetTime-time,StableStep(state,material));bool success=false;
    for(int retry=0;retry<24;++retry){
      Check(dt>std::max(1e-18,interval*1e-14) && time+dt>time,"Gas timestep collapsed; check EOS or severe cavity collapse.");
      const double fraction=(time+dt-start)/interval,volume=initialVolume+fraction*(endVolume-initialVolume);
      const double radius=settings.geometry==2 ? std::sqrt(volume/pi) : volume;
      try{impulse+=dt*Step(dt,radius,material);success=true;break;}catch(const std::runtime_error&){dt*=.5;}
    }
    Check(success,"Gas step repeatedly left the physical state domain.");time+=dt;
    Rezone();
    if(targetTime-time<interval*1e-14)time=targetTime;
  }
  return impulse/interval;
}
GasSnapshot GasDynamics::Snapshot() const {
  GasSnapshot snapshot;snapshot.radius=position.back();snapshot.wallWork=wallWork;snapshot.substeps=substeps;snapshot.rezones=rezones;
  for(std::size_t i=0;i<mass.size();++i)(products[i] ? snapshot.productMass : snapshot.airMass)+=mass[i];
  for(std::size_t i=0;i<mass.size();++i)snapshot.internalEnergy+=mass[i]*energy[i];
  for(std::size_t j=0;j<mass.size();++j)snapshot.kineticEnergy+=.5*mass[j]*velocity[j]*velocity[j];
  snapshot.wallPressure=WallPressure();return snapshot;
}
double GasDynamics::WallPressure() const {
  const std::size_t i=mass.size()-1;
  const double rho=mass[i]/(Volume(position[i+1])-Volume(position[i]));
  const auto eos=products[i] ? ProductsEOS(settings,rho,energy[i])
    : GasThermodynamics{(settings.airGamma-1)*rho*energy[i],settings.airGamma*(settings.airGamma-1)*energy[i]};
  const double sound=std::sqrt(eos.soundSpeedSquared);
  return HLLC(rho,velocity[i],eos.pressure,sound,rho,2*wallVelocity-velocity[i],eos.pressure,sound).pressure;
}
std::vector<double> GasDynamics::Densities() const {
  std::vector<double> values(mass.size());for(std::size_t i=0;i<mass.size();++i)values[i]=mass[i]/(Volume(position[i+1])-Volume(position[i]));return values;
}
std::vector<double> GasDynamics::Pressures() const {return Evaluate({position,velocity,energy}).p;}
}
