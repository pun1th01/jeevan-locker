import React from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { Navigate } from 'react-router-dom';

export default function Dashboard() {
  const { user, logout } = useAuthStore();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">Dashboard</h1>
      <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
        <p className="text-lg">Welcome back, <span className="text-brand-500">{user.name}</span></p>
        <p className="text-slate-400 mt-2">Role: {user.role.toUpperCase()}</p>
        
        <button 
          onClick={logout}
          className="mt-6 px-4 py-2 bg-red-500 text-white rounded font-semibold hover:bg-red-600"
        >
          Logout
        </button>
      </div>
    </div>
  );
}