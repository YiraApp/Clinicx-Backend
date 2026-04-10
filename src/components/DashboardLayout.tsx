import { Outlet, Navigate } from "react-router-dom"
import { Sidebar } from "./Sidebar"
import { useAppSelector } from "@/store"
import type { Role } from "@/types/models/account/role.model"

export function DashboardLayout() {
  const { isAuthenticated, selectedRole } = useAppSelector((state) => state.auth)

  if (!isAuthenticated || !selectedRole) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar role={selectedRole.RoleName as Role} />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
