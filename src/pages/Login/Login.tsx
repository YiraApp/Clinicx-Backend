import type React from "react"
import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { User, Stethoscope, Users, Shield, Eye, EyeOff, Zap, TrendingUp, type LucideIcon } from "lucide-react"
import logo from "@/assets/images/yira.webp"

import type { Role } from "@/types/models/account/role.model"
import { AuthService } from "@/services/account/auth.service"
import { RoleService } from "@/services/account/role.service"
import type { ApiRole } from "@/types/models/account/api-role.model"
import { useAppDispatch, useAppSelector } from "@/store"
import { loginSuccess, setSidebarMenu } from "@/store/slices/authSlice"
import { fetchRoles } from "@/store/slices/roleSlice"
import { SidebarService } from "@/services/sidebar.service"

export default function LoginPage() {
    const [identity, setIdentity] = useState("")
    const [password, setPassword] = useState("")
    const [role, setRole] = useState<Role | "">("")
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState("")
    const [isHiding, setIsHiding] = useState(false)
    const [fieldErrors, setFieldErrors] = useState<{ identity?: string; password?: string; role?: string }>({})
    const [wasSubmitted, setWasSubmitted] = useState(false)
    const { roles: apiRoles, isLoading: isRolesLoading, error: rolesError } = useAppSelector(state => state.role)
    const [roleId, setRoleId] = useState<string | string[]>("")
    const navigate = useNavigate()
    const dispatch = useAppDispatch()

    // Grouping logic for UI
    const groupedRoles = useMemo(() => {
        if (!apiRoles.length) return []

        const admins = apiRoles.filter(r => r.RoleName.toLowerCase().includes("admin"))
        const others = apiRoles.filter(r => !r.RoleName.toLowerCase().includes("admin"))

        const result: { id: string; label: string; value: string; isGroup?: boolean; roles?: ApiRole[] }[] = []

        const firstAdmin = admins[0]
        if (firstAdmin) {
            result.push({
                id: firstAdmin.Id, // Use first admin's ID for the group
                label: "Administrator (System / Org / Hosp)",
                value: firstAdmin.RoleName,
                isGroup: true,
                roles: admins
            })
        }

        others.forEach(r => {
            result.push({
                id: r.Id,
                label: r.RoleName,
                value: r.RoleName
            })
        })

        return result
    }, [apiRoles])

    // Auto-hide error smoothly after 6 seconds
    useEffect(() => {
        if (error || Object.keys(fieldErrors).length > 0) {
            setIsHiding(false)
            const hideTimer = setTimeout(() => {
                setIsHiding(true)
                // Wait for the fade-out animation (300ms) before clearing the error state
                setTimeout(() => {
                    setError("")
                    setFieldErrors({})
                    setIsHiding(false)
                }, 300)
            }, 6000)
            return () => clearTimeout(hideTimer)
        }
    }, [error, fieldErrors])

    // Load roles via Redux thunk
    useEffect(() => {
        dispatch(fetchRoles())
    }, [dispatch])

    // Sync roles error if needed
    useEffect(() => {
        if (rolesError) {
            setError(rolesError)
        }
    }, [rolesError])

    const validateField = (name: string, value: string) => {
        const newErrors = { ...fieldErrors }

        if (name === "identity") {
            if (!value) newErrors.identity = "Email or Phone is required"
            else delete newErrors.identity
        } else if (name === "password") {
            if (!value) newErrors.password = "Password is required"
            else if (value.length < 6) newErrors.password = "Password must be at least 6 characters"
            else delete newErrors.password
        } else if (name === "role") {
            if (!value) newErrors.role = "Please select a role"
            else delete newErrors.role
        }

        setFieldErrors(newErrors)
    }

    const handleIdentityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setIdentity(val)
        if (wasSubmitted) validateField("identity", val)
    }

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setPassword(val)
        if (wasSubmitted) validateField("password", val)
    }

    const handleRoleChange = (val: string) => {
        const found = groupedRoles.find(g => g.id === val)
        if (found) {
            setRole(found.value as Role)
            if (found.isGroup && found.roles) {
                setRoleId(found.roles.map(r => r.Id))
            } else {
                setRoleId(found.id)
            }
        }
        if (wasSubmitted) validateField("role", val)
    }

    const roleIcons: Record<string, LucideIcon> = {
        admin: Shield,
        provider: Stethoscope,
        patient: User,
        frontdesk: Users,
        "Hospital Admin": Shield,
        "Org Admin": Shield,
        "Yira System Admin": Zap,
        "Front Desk": Users,
        "Provider": Stethoscope,
        "Patient": User
    }

    const validateForm = () => {
        const errors: { identity?: string; password?: string; role?: string } = {}
        if (!identity) {
            errors.identity = "Email or Phone Number is required"
        }

        if (!password) errors.password = "Password is required"
        else if (password.length < 6) errors.password = "Password must be at least 6 characters"

        if (!role) errors.role = "Please select a role"

        setFieldErrors(errors)
        return Object.keys(errors).length === 0
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setWasSubmitted(true)
        setError("")
        setFieldErrors({})

        if (!validateForm()) return

        setIsLoading(true)

        try {
            // Simulate network delay
            await new Promise((resolve) => setTimeout(resolve, 800))

            const loginPayload = {
                identity: identity.toLowerCase(),
                password: password,
                roleId: roleId
            }
            console.log("Login Request Payload:", loginPayload)

            const authData = await AuthService.login(loginPayload)
            console.log("Login Success Response:", authData)

            // Find the role in the response that matches the user's selection
            // If they picked an admin group, we check for any admin role
            const isAdminGroup = role.toLowerCase().includes("admin")
            const matchedRole = authData.user.Roles.find(r =>
                isAdminGroup ? r.RoleName.toLowerCase().includes("admin") : r.RoleName === role
            )

            if (!matchedRole) {
                console.error("No matching role found for:", role, authData.user.Roles)
                setError(`You are not assigned the role of ${role} in our system.`)
                setIsLoading(false)
                return
            }

            console.log("Matched Role Details:", {
                RoleId: matchedRole.RoleId,
                OrgId: matchedRole.OrganizationId,
                HospId: matchedRole.HospitalId
            })

            // Dispatch to Redux (handles persistence internally)
            dispatch(loginSuccess({
                response: authData,
                selectedRole: matchedRole
            }))

            // Fetch sidebar to find the correct landing page AND cache it for the Sidebar component
            try {
                const sidebarMenu = await SidebarService.getSidebar(
                    matchedRole.RoleId,
                    matchedRole.OrganizationId ?? null,
                    matchedRole.HospitalId ?? null
                )

                // Cache in Redux so Sidebar component doesn't need to fetch it again
                if (sidebarMenu) {
                    dispatch(setSidebarMenu(sidebarMenu))
                }

                if (sidebarMenu && sidebarMenu.length > 0 && sidebarMenu[0]?.Route) {
                    console.log("Navigating to sidebar landing page:", sidebarMenu[0].Route)
                    navigate(sidebarMenu[0].Route)
                } else {
                    navigate("/dashboard")
                }
            } catch (error) {
                console.error("Failed to fetch sidebar layout:", error)
                navigate("/dashboard")
            }
        } catch (err: any) {
            const backendError = err.response?.data?.error || err.response?.data?.message || err.message
            setError(backendError || "An error occurred. Please try again.")
        } finally {
            setIsLoading(false)
        }
    }

    const getRoleIcon = (roleName: string) => {
        const IconComponent = roleIcons[roleName]
        return IconComponent ? <IconComponent className="w-4 h-4" /> : <User className="w-4 h-4" />
    }

    return (
        <div className="min-h-screen bg-white flex">
            {/* Left Side - Hero/Branding Section */}
            <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-slate-900 via-indigo-900 to-slate-900 flex-col justify-between p-12 relative overflow-hidden">
                {/* Animated background elements */}
                <div className="absolute inset-0 opacity-10">
                    <div className="absolute top-20 left-20 w-72 h-72 bg-indigo-500 rounded-full mix-blend-multiply filter blur-xl animate-pulse"></div>
                    <div className="absolute bottom-20 right-20 w-72 h-72 bg-blue-500 rounded-full mix-blend-multiply filter blur-xl animate-pulse animation-delay-2000"></div>
                </div>

                {/* Top Logo */}
                <div className="relative z-10">
                    <div className="w-16 h-16 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center border border-white/20 shadow-2xl overflow-hidden">
                        <img src={logo} alt="Yira Logo" className="w-12 h-12 object-contain rounded-xl" />
                    </div>
                </div>

                {/* Center Content */}
                <div className="relative z-10 flex flex-col gap-8">
                    <div className="space-y-4">
                        <h1 className="text-5xl font-bold text-white leading-tight">
                            Healthcare Management Reimagined
                        </h1>
                        <p className="text-lg text-slate-300 leading-relaxed">
                            AI-powered platform connecting providers, patients, and administrators in a seamless digital healthcare ecosystem.
                        </p>
                    </div>

                    {/* Feature Cards */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg p-4 hover:bg-white/15 transition-all">
                            <Zap className="w-6 h-6 text-amber-400 mb-2" />
                            <p className="text-white font-medium text-sm">Instant Access</p>
                            <p className="text-slate-300 text-xs mt-1">Get started in seconds</p>
                        </div>
                        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg p-4 hover:bg-white/15 transition-all">
                            <TrendingUp className="w-6 h-6 text-emerald-400 mb-2" />
                            <p className="text-white font-medium text-sm">AI Insights</p>
                            <p className="text-slate-300 text-xs mt-1">Smart recommendations</p>
                        </div>
                    </div>
                </div>

                {/* Bottom Text */}
                <div className="relative z-10 text-slate-400 text-sm">
                    <p>Trusted by leading healthcare organizations across India</p>
                </div>
            </div>

            {/* Right Side - Login Form */}
            <div className="w-full lg:w-1/2 flex items-center justify-center p-6 bg-slate-50">
                <div className="w-full max-w-md">
                    <Card className="shadow-none border-0 bg-white">
                        <CardHeader className="space-y-1 pb-4 text-center">
                            {/* Mobile Logo */}
                            <div className="lg:hidden relative inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-lg mb-4 mx-auto overflow-hidden">
                                <img src={logo} alt="Yira Logo" className="w-12 h-12 object-contain rounded-lg" />
                            </div>
                            <CardTitle className="text-2xl font-bold text-slate-900">Welcome to Yira</CardTitle>
                            <CardDescription className="text-slate-600">
                                AI-Powered Healthcare Management System
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <form onSubmit={handleSubmit} className="space-y-3">
                                <div className="space-y-1.5">
                                    <Label htmlFor="identity" className="text-sm font-medium text-slate-700">
                                        Email or Phone Number
                                    </Label>
                                    <Input
                                        id="identity"
                                        type="text"
                                        placeholder="Enter email or phone"
                                        value={identity}
                                        onChange={handleIdentityChange}
                                        className={`h-9 bg-slate-50 border-slate-200 focus:bg-white focus:border-indigo-500 ${fieldErrors.identity ? 'border-red-500 ring-red-500' : ''}`}
                                    />
                                    <div
                                        className={cn(
                                            "grid transition-all duration-300 ease-in-out",
                                            (fieldErrors.identity && !isHiding) ? "grid-rows-[1fr] opacity-100 mt-0.5" : "grid-rows-[0fr] opacity-0 mt-0"
                                        )}
                                    >
                                        <div className="overflow-hidden">
                                            {fieldErrors.identity && (
                                                <p className={cn(
                                                    "text-[12px] font-medium text-red-500",
                                                    isHiding ? "opacity-0 translate-y-[-5px]" : "animate-in fade-in slide-in-from-bottom-1 duration-200"
                                                )}>
                                                    {fieldErrors.identity}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="password" className="text-sm font-medium text-slate-700">
                                        Password
                                    </Label>
                                    <div className="relative">
                                        <Input
                                            id="password"
                                            type={showPassword ? "text" : "password"}
                                            placeholder="Enter your password"
                                            value={password}
                                            onChange={handlePasswordChange}
                                            className={`h-9 bg-slate-50 border-slate-200 focus:bg-white focus:border-indigo-500 pr-10 ${fieldErrors.password ? 'border-red-500 ring-red-500' : ''}`}
                                        />
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="absolute right-0 top-0 h-9 px-3 py-2 hover:bg-transparent"
                                            onClick={() => setShowPassword(!showPassword)}
                                        >
                                            {showPassword ? <EyeOff className="w-4 h-4 text-slate-400" /> : <Eye className="w-4 h-4 text-slate-400" />}
                                        </Button>
                                    </div>
                                    <div
                                        className={cn(
                                            "grid transition-all duration-300 ease-in-out",
                                            (fieldErrors.password && !isHiding) ? "grid-rows-[1fr] opacity-100 mt-0.5" : "grid-rows-[0fr] opacity-0 mt-0"
                                        )}
                                    >
                                        <div className="overflow-hidden">
                                            {fieldErrors.password && (
                                                <p className={cn(
                                                    "text-[12px] font-medium text-red-500",
                                                    isHiding ? "opacity-0 translate-y-[-5px]" : "animate-in fade-in slide-in-from-bottom-1 duration-200"
                                                )}>
                                                    {fieldErrors.password}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="role" className="text-sm font-medium text-slate-700">
                                        Select Role
                                    </Label>
                                    <Select
                                        value={Array.isArray(roleId) ? (apiRoles.find(r => roleId.includes(r.Id))?.Id || "") : roleId}
                                        onValueChange={handleRoleChange}
                                    >
                                        <SelectTrigger className={`h-9 bg-slate-50 border-slate-200 focus:bg-white focus:border-indigo-500 ${fieldErrors.role ? 'border-red-500' : ''}`}>
                                            <SelectValue placeholder="Choose your role" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {isRolesLoading ? (
                                                <SelectItem value="loading">Loading roles...</SelectItem>
                                            ) : (
                                                groupedRoles.map((r) => (
                                                    <SelectItem key={r.id} value={r.id}>
                                                        <div className="flex items-center space-x-2">
                                                            {getRoleIcon(r.isGroup ? "Hospital Admin" : r.label)}
                                                            <span>{r.label}</span>
                                                        </div>
                                                    </SelectItem>
                                                ))
                                            )}
                                        </SelectContent>
                                    </Select>
                                    <div
                                        className={cn(
                                            "grid transition-all duration-300 ease-in-out",
                                            (fieldErrors.role && !isHiding) ? "grid-rows-[1fr] opacity-100 mt-0.5" : "grid-rows-[0fr] opacity-0 mt-0"
                                        )}
                                    >
                                        <div className="overflow-hidden">
                                            {fieldErrors.role && (
                                                <p className={cn(
                                                    "text-[12px] font-medium text-red-500",
                                                    isHiding ? "opacity-0 translate-y-[-5px]" : "animate-in fade-in slide-in-from-bottom-1 duration-200"
                                                )}>
                                                    {fieldErrors.role}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div
                                    className={cn(
                                        "grid transition-all duration-300 ease-in-out",
                                        (error && !isHiding) ? "grid-rows-[1fr] opacity-100 mb-4" : "grid-rows-[0fr] opacity-0 mb-0"
                                    )}
                                >
                                    <div className="overflow-hidden">
                                        {error && (
                                            <Alert
                                                variant="destructive"
                                                className={cn(
                                                    "bg-red-50 border-red-200",
                                                    isHiding
                                                        ? "opacity-0 translate-y-[-10px] scale-95"
                                                        : "animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-300"
                                                )}
                                            >
                                                <AlertDescription className="text-red-800">{error}</AlertDescription>
                                            </Alert>
                                        )}
                                    </div>
                                </div>

                                <Button
                                    type="submit"
                                    className="w-full h-9 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white font-medium shadow-lg rounded-lg transition-all duration-300 transform active:scale-[0.98]"
                                    disabled={isLoading}
                                >
                                    {isLoading ? (
                                        <span className="flex items-center gap-2">
                                            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                                            Signing in...
                                        </span>
                                    ) : (
                                        "Sign In"
                                    )}
                                </Button>
                            </form>

                            <div className="text-center pt-4 border-t border-slate-200">
                                <p className="text-sm text-slate-600">
                                    Don't have an account?{" "}
                                    <Button
                                        variant="link"
                                        className="p-0 h-auto text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                                        onClick={() => navigate("/register")}
                                    >
                                        Register here
                                    </Button>
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
