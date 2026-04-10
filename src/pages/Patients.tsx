import { UserCheck, Clock, Search, Filter } from 'lucide-react';

export default function Patients() {
    const patientData = [
        { name: 'John Doe', age: 45, diagnosis: 'Hypertension', status: 'Active', gender: 'Male' },
        { name: 'Jane Smith', age: 34, diagnosis: 'Diabetes Type 2', status: 'Stable', gender: 'Female' },
        { name: 'Robert Johnson', age: 58, diagnosis: 'Osteoarthritis', status: 'Pending', gender: 'Male' },
        { name: 'Emma Wilson', age: 29, diagnosis: 'Asthma', status: 'Chronic', gender: 'Female' },
    ];

    return (
        <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Patients Directory</h1>
                    <p className="text-sm text-slate-500">Manage and view patient medical records</p>
                </div>
                <button className="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100">
                    Add New Patient
                </button>
            </div>

            <div className="flex gap-4">
                <div className="flex-1 relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
                    <input
                        type="text"
                        placeholder="Search patients by name or ID..."
                        className="w-full bg-white border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all text-sm"
                    />
                </div>
                <button className="flex items-center gap-2 px-4 py-2 font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors text-sm">
                    <Filter className="w-4 h-4" />
                    Filter
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {patientData.map((patient) => (
                    <div key={patient.name} className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group cursor-pointer">
                        <div className="w-12 h-12 bg-slate-100 rounded-full mb-4 flex items-center justify-center text-slate-400 font-bold group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
                            {patient.name[0]}
                        </div>
                        <h3 className="font-bold text-slate-800">{patient.name}</h3>
                        <p className="text-xs font-medium text-slate-400 mb-2">{patient.gender}, {patient.age} years old</p>
                        <div className="text-sm font-medium text-slate-600 mb-4 truncate">{patient.diagnosis}</div>
                        <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${patient.status === 'Active' ? 'bg-emerald-50 text-emerald-600' :
                                    patient.status === 'Stable' ? 'bg-blue-50 text-blue-600' :
                                        'bg-amber-50 text-amber-600'
                                }`}>
                                {patient.status}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
