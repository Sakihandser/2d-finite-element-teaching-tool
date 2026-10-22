// MFEM 4.10 linalg/ode.cpp excerpt. BSD-3-Clause; see ../LICENSE.
// In this routine state[0] represents d2xdt2
void NewmarkSolver::Step(Vector &x, Vector &dxdt, real_t &t, real_t &dt)
{
   real_t fac0 = 0.5 - beta;
   real_t fac2 = 1.0 - gamma;
   real_t fac3 = beta;
   real_t fac4 = gamma;

   // In the first pass compute d2xdt2 directly from operator.
   if (state.Size() == 0)
   {
      if (no_mult)
      {
         MidPointStep(x, dxdt, t, dt);
         return;
      }
      else
      {
         f->Mult(x, dxdt, state[0]);
      }
      state.Increment();
   }
   f->SetTime(t + dt);

   x.Add(dt, dxdt);
   x.Add(fac0*dt*dt, state[0]);
   dxdt.Add(fac2*dt, state[0]);

   f->SetTime(t + dt);
   f->ImplicitSolve(fac3*dt*dt, fac4*dt, x, dxdt, state[0]);

   x.Add(fac3*dt*dt, state[0]);
   dxdt.Add(fac4*dt, state[0]);
   t += dt;
}
