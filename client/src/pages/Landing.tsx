import React from 'react';
import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-5xl font-bold text-brand-500 mb-4">JeevanLocker</h1>
      <p className="text-xl max-w-2xl mb-8">Secure, blockchain-ready medical records across your lifecycle.</p>
      
      <div className="flex gap-4">
        <Link to="/login" className="px-6 py-3 rounded-lg bg-brand-500 text-slate-900 font-semibold hover:bg-opacity-90">Login</Link>
        <Link to="/register" className="px-6 py-3 rounded-lg border border-brand-500 text-brand-500 font-semibold hover:bg-slate-900">Register</Link>
      </div>
    </div>
  );
}