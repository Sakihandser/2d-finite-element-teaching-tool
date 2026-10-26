#pragma once
// NA adapted from LANL Singularity-EOS eos_noble_abel.hpp (BSD-3-Clause).
// NASG equations checked against JorisCaze/NASG-EOS_Calibration (MIT).
// vdW pressure adapted from Sho Hirose's eos (MIT), converted from molar
// to specific volume and closed by constant Cv caloric energy.
// Immutable original sources/licenses: third_party/real-gas-reference/.
#include <cmath>
#include <stdexcept>

namespace fem {
struct GasLaw {int model=0;double gamma=1.4,b=0,pinf=0,q=0,a=0;};
struct GasThermodynamics {double pressure=0,soundSpeedSquared=0;};
inline void GasLawCheck(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
inline GasLaw ActiveGasLaw(GasLaw c){
  if(c.model==0){c.b=c.pinf=c.q=c.a=0;return c;}
  if(c.model==3)c.pinf=c.a=0;
  if(c.model==4)c.b=c.a=0;
  if(c.model==5)c.a=0;
  if(c.model==6)c.pinf=0;
  return c;
}
inline void ValidateGasLaw(const GasLaw& raw){
  const auto c=ActiveGasLaw(raw);
  GasLawCheck((c.model==0||c.model==3||c.model==4||c.model==5||c.model==6)&&c.gamma>1&&c.gamma<=10&&c.b>=0&&c.pinf>=0&&c.q>=0&&c.a>=0&&std::isfinite(c.gamma+c.b+c.pinf+c.q+c.a),"Invalid nonideal gas constitutive parameters.");
  GasLawCheck(!(c.model==3||c.model==5||c.model==6)||c.b>0,"Selected gas EOS requires positive covolume.");
  GasLawCheck(!(c.model==4||c.model==5)||c.pinf>0,"Selected gas EOS requires positive pressure offset.");
  GasLawCheck(c.model!=6||c.a>0,"Van der Waals requires positive attraction.");
}
inline GasThermodynamics EvaluateGasLaw(const GasLaw& raw,double rho,double energy){
  const auto c=ActiveGasLaw(raw);const double d=1-c.b*rho,u=energy-c.q;
  GasLawCheck(rho>0&&energy>0&&d>0&&std::isfinite(rho+energy),"Gas density/internal energy must be positive and covolume times density below one.");
  double pressure=0,c2=0;
  if(c.model==6){
    const double thermal=u+c.a*rho;pressure=(c.gamma-1)*rho*thermal/d-c.a*rho*rho;c2=c.gamma*(pressure+c.a*rho*rho)/(rho*d)-2*c.a*rho;
    const double stable=(c.gamma-1)*thermal/(d*d)-2*c.a*rho;
    GasLawCheck(thermal>0&&thermal>8*c.a/(27*(c.gamma-1)*c.b)&&stable>0,"Van der Waals requires a stable single phase above the critical temperature.");
  }else {pressure=(c.gamma-1)*rho*u/d-c.gamma*c.pinf;c2=c.gamma*(pressure+c.pinf)/(rho*d);GasLawCheck(u>0,"Gas internal energy must exceed its energy reference.");}
  GasLawCheck(pressure>0&&c2>0&&std::isfinite(pressure+c2),"Nonideal gas EOS left the positive-pressure or hyperbolic domain.");
  return {pressure,c2};
}
inline double GasEnergyFromPressure(const GasLaw& raw,double rho,double pressure){
  const auto c=ActiveGasLaw(raw);const double d=1-c.b*rho;
  return c.model==6?c.q+(pressure+c.a*rho*rho)*d/((c.gamma-1)*rho)-c.a*rho:c.q+(pressure+c.gamma*c.pinf)*d/((c.gamma-1)*rho);
}
}
