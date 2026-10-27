#include "../../TensoraCore/GasDynamics.h"
#include <iostream>
#include <iomanip>
#include <string>
using namespace fem;
int main(int argc,char** argv){try{
  const std::string mode=argc>1?argv[1]:"eos";const int law=argc>2?std::stoi(argv[2]):3;
  GasLaw c;c.model=law;c.gamma=1.4;c.b=.01;c.pinf=2e4;c.q=2e4;c.a=200;c=ActiveGasLaw(c);ValidateGasLaw(c);
  std::cout<<std::setprecision(16);
  if(mode=="eos"){
    const double rho=5,e=2e6,h=1e-5;const auto f=EvaluateGasLaw(c,rho,e),plus=EvaluateGasLaw(c,rho+h,e+h*f.pressure/(rho*rho)),minus=EvaluateGasLaw(c,rho-h,e-h*f.pressure/(rho*rho));
    std::cout<<"{\"pressure\":"<<f.pressure<<",\"c2\":"<<f.soundSpeedSquared<<",\"derivative\":"<<(plus.pressure-minus.pressure)/(2*h)<<",\"energy\":"<<GasEnergyFromPressure(c,rho,f.pressure)<<"}";return 0;
  }
  GasParameters p;p.cells=argc>3?std::stoi(argv[3]):64;p.geometry=mode=="moving"?2:1;p.radius=1;p.chargeRadius=mode=="moving"?1:.5;
  p.productLaw=p.airLaw=c;p.omega=c.gamma-1;p.airGamma=c.gamma;p.productDensity=5;p.airDensity=.6;p.airPressure=mode=="contact"?1e6:1e5;
  p.productEnergy=mode=="contact"?GasEnergyFromPressure(c,p.productDensity,p.airPressure):2e6;
  if(mode=="invalid"){p.productDensity=101;}
  if(mode=="vent"){p.ventEnds=1;}
  GasDynamics gas(p);const double initial=gas.InitialEnergy(),t=mode=="moving"?1e-5:1e-4;
  gas.Advance(t,mode=="moving"?.99:1);const auto s=gas.Snapshot();const auto pressure=gas.Pressures();
  double minP=1e300,maxP=0,maxV=0;for(std::size_t i=0;i<pressure.size();i++){minP=std::min(minP,pressure[i]);maxP=std::max(maxP,pressure[i]);maxV=std::max(maxV,std::abs(gas.Velocities()[i]));}
  std::cout<<"{\"initial\":"<<initial<<",\"internal\":"<<s.internalEnergy<<",\"kinetic\":"<<s.kineticEnergy<<",\"work\":"<<s.wallWork<<",\"minPressure\":"<<minP<<",\"maxPressure\":"<<maxP<<",\"maxVelocity\":"<<maxV<<",\"productMass\":"<<s.productMass<<",\"airMass\":"<<s.airMass<<"}";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}
