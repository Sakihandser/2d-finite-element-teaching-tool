#pragma once
// Independent implementation of the published JH2 and Drucker-Prager equations.
// References and parameter conventions: docs/ROCK_CONSTITUTIVE.md.
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>
#include <memory>

namespace fem { namespace rock {
using Tensor=Eigen::Matrix3d;
inline Tensor Dev(const Tensor& t){return t-Tensor::Identity()*(t.trace()/3.);}
inline double Q(const Tensor& s){return std::sqrt(1.5*Dev(s).squaredNorm());}
struct Parameters {
  int law=0;
  bool logarithmicVolume=false;
  double E=0,nu=0,ft=0,fc=0,gf=100,h=1;
  double A=0,N=0,B=0,M=0,C=0,rate0=1,HEL=0,pHEL=0,T=0,D1=0,D2=0,maxStrength=0,K1=0,K2=0,K3=0,beta=0,referenceLength=0;
  double friction=0,dilation=0;
  double normalizationStress=0;
  // Active model's SOLID1 fields only; order is shared with blast-materials.js.
  std::vector<double> solid;
  std::shared_ptr<const Eigen::Matrix<double,6,6>> orthotropic;
  double G()const{return E/(2*(1+nu));}
  double K()const{return law==3 ? K1 : E/(3*(1-2*nu));}
  double SigmaHEL()const{return normalizationStress>0 ? normalizationStress : 1.5*(HEL-pHEL);}
};
struct State {
  Tensor stress=Tensor::Zero(),effective=Tensor::Zero(),strain=Tensor::Zero();
  double damage=0,history=0,plasticStrain=0,plasticWork=0,bulking=0,bulkingEnergy=0,initialPressure=0,initialVolumeStrain=0,tensileOpening=0;
  double temperature=0,pc=0,plasticVolume=0,maxCompression=0,solidEnergy=0,hardeningEnergy=0;
  std::vector<Tensor> memory;
};
inline bool Hyperelastic(const Parameters& p){return p.law==8 || p.law==13;}
inline void SolidStep(const Parameters&,State&,const Tensor&,double,bool);
inline double SolidStoredEnergy(const Parameters&,const State&);
inline void SolidInitialize(const Parameters&,State&,bool);
inline double EOS(const Parameters& p,double volumeStrain){
  // mu = rho/rho0 - 1, with small-strain volume J=1+tr(epsilon).
  if(!p.logarithmicVolume && volumeStrain<=-0.8)throw std::runtime_error("Rock volume collapsed; refine mesh/time step or use a particle solver.");
  const double mu=p.logarithmicVolume ? std::expm1(-volumeStrain) : -volumeStrain/(1+volumeStrain);
  return mu>0 ? ((p.K3*mu+p.K2)*mu+p.K1)*mu : p.K1*mu;
}
inline double Rate(const Parameters& p,double rate){return 1+p.C*std::log(std::max(1.,rate/p.rate0));}
inline double Intact(const Parameters& p,double pressure,double rate){return p.SigmaHEL()*p.A*std::pow(std::max(0.,(pressure+p.T)/p.pHEL),p.N)*Rate(p,rate);}
inline double Failed(const Parameters& p,double pressure,double rate){return p.SigmaHEL()*std::min(p.maxStrength,p.B*std::pow(std::max(0.,pressure/p.pHEL),p.M)*Rate(p,rate));}
inline double Strength(const Parameters& p,double pressure,double rate,double damage){return (1-damage)*Intact(p,pressure,rate)+damage*Failed(p,pressure,rate);}
inline double FailureStrain(const Parameters& p,double pressure){
  const double scale=p.referenceLength>0 ? p.referenceLength/p.h : 1.;
  return std::max(1e-8,p.D1*std::pow(std::max(0.,(pressure+p.T)/p.pHEL),p.D2)*scale);
}
inline void Tensile(const Parameters& p,State& s,bool damageEnabled){
  Eigen::SelfAdjointEigenSolver<Tensor> eig(s.effective);
  if(eig.info()!=Eigen::Success)throw std::runtime_error("Rock principal stress decomposition failed.");
  if(damageEnabled){
    s.history=std::max(s.history,std::max(0.,eig.eigenvalues().maxCoeff())/p.E);
    const double eps0=p.ft/p.E,soft=p.gf/(p.h*p.ft)-.5*eps0;
    if(!(p.ft>0 && soft>0))throw std::runtime_error("Tensile damage needs measured ft and a compatible Gf/mesh.");
    if(s.history>eps0)s.damage=std::max(s.damage,1-eps0/s.history*std::exp(-(s.history-eps0)/soft));
  }
  auto values=eig.eigenvalues().eval();for(int i=0;i<3;++i)if(values[i]>0)values[i]*=std::max(1e-6,1-s.damage);
  s.stress=eig.eigenvectors()*values.asDiagonal()*eig.eigenvectors().transpose();
}
inline void Step(const Parameters& p,State& s,const Tensor& increment,double dt,bool damageEnabled){
  if(p.law>=4){SolidStep(p,s,increment,dt,damageEnabled);return;}
  const double G=p.G(),K=p.K();s.strain+=increment;
  if(p.law==1){s.effective+=2*G*Dev(increment)+K*increment.trace()*Tensor::Identity();s.stress=s.effective;return;}
  if(p.law==0 || p.law==2){
    s.effective+=2*G*Dev(increment)+K*increment.trace()*Tensor::Identity();
    if(p.law==2){
      const double sinPhi=std::sin(p.friction*3.141592653589793/180),sinPsi=std::sin(p.dilation*3.141592653589793/180);
      const double alpha=6*sinPhi/(3-sinPhi),flow=6*sinPsi/(3-sinPsi),q0=p.fc*(1-alpha/3);
      const double pressure=-s.effective.trace()/3,q=Q(s.effective),yield=std::max(0.,q0+alpha*pressure);
      if(q>yield){
        const double dep=std::min(q/(3*G),(q-yield)/(3*G+alpha*K*flow));
        const double nextP=pressure+K*flow*dep,nextQ=std::max(0.,q-3*G*dep);
        s.effective=(q>0 ? Dev(s.effective)*(nextQ/q) : Tensor::Zero().eval())-nextP*Tensor::Identity();
        s.plasticStrain+=dep;s.plasticWork+=std::max(0.,.5*(q+nextQ)*dep-.5*(pressure+nextP)*flow*dep);
      }
    }
    Tensile(p,s,damageEnabled);return;
  }
  const double rawPressure=EOS(p,s.strain.trace())-EOS(p,s.initialVolumeStrain)+s.initialPressure+s.bulking;
  double pressure=rawPressure;
  Tensor deviator=Dev(s.effective)+2*G*Dev(increment);
  const double q=std::sqrt(1.5*deviator.squaredNorm()),rate=std::sqrt(2./3*Dev(increment).squaredNorm())/dt;
  const double oldDamage=s.damage,fail=FailureStrain(p,pressure);
  if(q>Strength(p,pressure,rate,s.damage)){
    const double intact=Intact(p,pressure,rate),failed=Failed(p,pressure,rate),yield=(1-oldDamage)*intact+oldDamage*failed;
    double dep=(q-yield)/(3*G);
    if(damageEnabled && oldDamage<1){
      const double denominator=3*G-(intact-failed)/fail;
      const double candidate=denominator>0 ? (q-yield)/denominator : -1;
      dep=candidate>=0 && candidate<=(1-oldDamage)*fail ? candidate : std::max(0.,(q-failed)/(3*G));
    }
    dep=std::clamp(dep,0.,q/(3*G));s.plasticStrain+=dep;if(damageEnabled)s.damage=std::min(1.,oldDamage+dep/fail);
    const double nextQ=std::max(0.,q-3*G*dep);deviator*=q>0 ? nextQ/q : 0;
    s.plasticWork+=.5*(q+nextQ)*dep;
    if(p.beta>0 && pressure>=0 && s.damage>oldDamage){
      const double y0=Strength(p,pressure,rate,oldDamage),y1=Strength(p,pressure,rate,s.damage);
      const double energy=std::max(0.,(y0*y0-y1*y1)/(6*G))*p.beta;
      const double delta=std::sqrt(pressure*pressure+2*K*energy)-pressure;
      s.bulking+=delta;pressure+=delta;s.bulkingEnergy+=energy;s.plasticWork=std::max(0.,s.plasticWork-energy);
    }
  }
  const double cutoff=-(1-s.damage)*p.T;
  if(pressure<cutoff){
    if(damageEnabled){const double dep=(cutoff-pressure)/K;s.damage=std::min(1.,s.damage+dep/FailureStrain(p,cutoff));s.plasticStrain+=dep;}
    const double capped=-(1-s.damage)*p.T;
    // Only newly created inelastic opening does work. Repeated evaluation of a
    // fully failed, stationary tensile state must never accumulate energy.
    const double opening=std::max(s.tensileOpening,(capped-pressure)/K);
    s.plasticWork+=std::max(0.,-.5*(-s.stress.trace()/3+capped)*(opening-s.tensileOpening));
    s.tensileOpening=opening;pressure=capped;
    const double limit=Strength(p,pressure,rate,s.damage),qNow=std::sqrt(1.5*deviator.squaredNorm());
    if(qNow>limit)deviator*=limit/qNow;
  }
  s.effective=s.stress=deviator-pressure*Tensor::Identity();
  if(!s.stress.allFinite())throw std::runtime_error("Non-finite rock stress; check constitutive parameters and time step.");
}
// Local plane stress is solved against a copy of the entire old state. Trial
// iterations never accumulate plastic strain/damage. Plane strain keeps ezz=0.
inline State Advance(const Parameters& p,const State& old,const Eigen::Vector3d& inplane,double dt,bool planeStrain,bool damageEnabled){
  auto evaluate=[&](double zz){State s=old;Tensor target=Tensor::Zero();target(0,0)=inplane[0];target(1,1)=inplane[1];target(0,1)=target(1,0)=inplane[2]/2;target(2,2)=zz;
    const Tensor delta=target-old.strain;const int n=std::max(1,static_cast<int>(std::ceil(delta.norm()/2e-4)));
    if(n>1024)throw std::runtime_error("Rock strain increment too large; reduce time step.");
    for(int i=0;i<n;++i){const double previousWork=s.plasticWork;Step(p,s,delta/n,dt/n,damageEnabled);
      if(p.logarithmicVolume)s.plasticWork=previousWork+std::exp(s.strain.trace()-s.initialVolumeStrain)*(s.plasticWork-previousWork);
    }return s;};
  if(planeStrain)return evaluate(0);
  double zz=old.strain(2,2)-p.nu/(1-p.nu)*((inplane[0]-old.strain(0,0))+(inplane[1]-old.strain(1,1)));
  State result=evaluate(zz);
  for(int k=0;k<18;++k){
    if(std::abs(result.stress(2,2))<1e-7*std::max(1e6,result.stress.norm()))return result;
    const double h=1e-7,deriv=(evaluate(zz+h).stress(2,2)-evaluate(zz-h).stress(2,2))/(2*h);
    if(!(deriv>1e-8*p.E))break;
    zz-=std::clamp(result.stress(2,2)/deriv,-.05,.05);result=evaluate(zz);
  }
  if(std::abs(result.stress(2,2))>1e-5*std::max(1e6,result.stress.norm()))throw std::runtime_error("Rock plane-stress return did not converge; reduce time step or use plane strain.");
  return result;
}
inline void Initialize(const Parameters& p,State& s,const Eigen::Vector3d& strain,const Eigen::Vector3d& stress,bool planeStrain){
  s.strain(0,0)=strain[0];s.strain(1,1)=strain[1];s.strain(0,1)=s.strain(1,0)=strain[2]/2;
  s.strain(2,2)=planeStrain ? 0 : -p.nu/(1-p.nu)*(strain[0]+strain[1]);
  s.stress(0,0)=stress[0];s.stress(1,1)=stress[1];s.stress(0,1)=s.stress(1,0)=stress[2];
  s.stress(2,2)=planeStrain ? p.nu*(stress[0]+stress[1]) : 0;s.effective=s.stress;
  s.initialPressure=-s.stress.trace()/3;s.initialVolumeStrain=s.strain.trace();
  if(p.law>=4)SolidInitialize(p,s,planeStrain);
}
inline double StoredEnergy(const Parameters& p,const State& s){
  if(p.law>=4)return SolidStoredEnergy(p,s);
  const double pressure=-s.stress.trace()/3;
  double bulk=pressure*pressure/(2*p.K());
  if(p.law==3 && pressure>0){
    const double volume=p.logarithmicVolume?std::exp(s.strain.trace()):1+s.strain.trace();
    if(volume>0 && volume<1){const double mu=1/volume-1,log=std::log1p(mu),inverse=1/(1+mu);
      bulk=p.K1*(log+inverse-1)+p.K2*(mu-2*log-inverse+1)+p.K3*(.5*mu*mu-2*mu+3*log+inverse-1);
    }
  }
  return std::max(0.,bulk)+Dev(s.stress).squaredNorm()/(4*p.G())+s.bulkingEnergy;
}
} }
#include "SolidConstitutive.h"
