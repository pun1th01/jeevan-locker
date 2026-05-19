import React from 'react';
import { Outlet } from 'react-router-dom';

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <header className="border-b border-slate-800 p-4 sticky top-0 bg-slate-950 z-50">
        <div className="container mx-auto flex items-center justify-between">
          <div className="text-2xl font-bold text-brand-500">JeevanLocker</div>
        </div>
      </header>
      
      <main className="container mx-auto">
        <Outlet />
      </main>
    </div>
  );
}