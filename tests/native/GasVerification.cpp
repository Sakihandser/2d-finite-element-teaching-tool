#include "../../TensoraCore/GasDynamics.h"
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
int main(int argc,char* argv[]) {
  try {
    const std::string mode=argc>1 ? argv[1] : "sod";
    fem::GasParameters p;p.geometry=mode=="radial" || mode=="moving" ? 2 : 1;
    p.cells=argc>2 ? std::stoi(argv[2]) : 200;p.radius=1;p.chargeRadius=.5;
    p.productDensity=1;p.productEnergy=2.5;p.omega=.4;p.airDensity=.125;p.airPressure=.1;p.airGamma=1.4;
    double duration=argc>3 ? std::stod(argv[3]) : .2;
    if(mode=="expansion" || mode=="vacuum"){
      const double u=mode=="vacuum"?4:2;const auto c=fem::GasDynamics::SolveContact(1,-u,.4,std::sqrt(.56),1,u,.4,std::sqrt(.56));
      std::cout<<std::setprecision(16)<<"{\"pressure\":"<<c.pressure<<",\"velocity\":"<<c.velocity<<",\"fallback\":"<<(c.rarefaction?"true":"false")<<"}";return 0;
    }
    if(mode=="eos") {
      p.A=20;p.B=3;p.R1=4.5;p.R2=1.1;p.omega=.3;
      const double rho=.7,e=100,delta=1e-6;
      const auto eos=fem::GasDynamics::ProductsEOS(p,rho,e);
      const auto plus=fem::GasDynamics::ProductsEOS(p,rho+delta,e+delta*eos.pressure/(rho*rho));
      const auto minus=fem::GasDynamics::ProductsEOS(p,rho-delta,e-delta*eos.pressure/(rho*rho));
      std::cout<<std::setprecision(16)<<"{\"pressure\":"<<eos.pressure<<",\"c2\":"<<eos.soundSpeedSquared<<",\"finiteDifference\":"<<(plus.pressure-minus.pressure)/(2*delta)<<"}";return 0;
    }
    if(mode=="contact" || mode=="moving")p.airPressure=1;
    if(mode=="axial"){p.geometry=2;p.chargeRadius=p.radius;p.productDensity=10;p.productEnergy=2.5e6;p.airPressure=1e5;p.ventEnds=2;p.specimenThickness=.05;}
    if(mode=="radial"){p.chargeRadius=.25;p.productEnergy=25;}
    if(mode=="blast" || mode=="blast-moving" || mode=="blast-jwl") {
      p=fem::GasParameters{};p.cells=argc>2 ? std::stoi(argv[2]) : 192;
      if(mode=="blast-jwl"){p.A=1e8;p.B=1e7;}
    }
    fem::GasDynamics gas(p);
    const double averagePressure=gas.Advance(duration,mode=="moving" ? .98 : mode=="blast-moving" ? .102 : p.radius);
    const auto s=gas.Snapshot();const auto pressure=gas.Pressures(),density=gas.Densities();
    std::cout<<std::setprecision(16)<<"{\"initialEnergy\":"<<gas.InitialEnergy()<<",\"internalEnergy\":"<<s.internalEnergy
      <<",\"kineticEnergy\":"<<s.kineticEnergy<<",\"wallWork\":"<<s.wallWork<<",\"wallPressure\":"<<s.wallPressure<<",\"substeps\":"<<s.substeps
      <<",\"rezones\":"<<s.rezones<<",\"productMass\":"<<s.productMass<<",\"airMass\":"<<s.airMass
      <<",\"ventedMass\":"<<s.ventedMass<<",\"ventedEnergy\":"<<s.ventedEnergy
      <<",\"averagePressure\":"<<averagePressure<<",\"cells\":[";
    for(std::size_t i=0;i<density.size();++i){if(i)std::cout<<",";std::cout<<"["<<.5*(gas.Positions()[i]+gas.Positions()[i+1])<<","<<density[i]<<","<<pressure[i]<<","<<gas.Velocities()[i]<<","<<gas.Positions()[i+1]-gas.Positions()[i]<<"]";}
    std::cout<<"]}";return 0;
  }catch(const std::exception& error){std::cerr<<error.what();return 1;}
}
