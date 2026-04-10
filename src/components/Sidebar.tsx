import type React from "react"

import { useState, useEffect, useMemo } from "react"
import { Link, useLocation, useNavigate, matchPath } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { signOut } from "@/lib/actions"
import * as Icons from "lucide-react"
import {
  ChevronDown,
  ChevronRight,
  Menu,
  X,
  Search,
} from "lucide-react"
import { GlobalPatientSearch } from "@/components/global-patient-search"
import { useLanguage } from "@/lib/i18n/language-context"
import { useAppDispatch, useAppSelector } from "@/store"
import { performLogout } from "@/store/slices/authSlice"
import SidebarService from "@/services/sidebar.service"
import type { SidebarMenuItem } from "@/services/sidebar.service"

import type { Role } from "@/types/models/account/role.model"

interface SidebarProps {
  role: Role
  organizationName?: string
  organizationCode?: string
}

interface MenuItem {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string | undefined
  children?: MenuItem[] | undefined
}

const getIcon = (iconName: string | null) => {
  if (!iconName) return Icons.Home

  // Try exact match first
  if ((Icons as any)[iconName]) return (Icons as any)[iconName]

  // Try case-insensitive or slug match
  const normalized = iconName.toLowerCase().replace(/_/, "")
  const found = Object.keys(Icons).find(
    key => key.toLowerCase() === normalized
  )

  return found ? (Icons as any)[found] : Icons.Home
}

export function Sidebar({ role: roleProp, organizationName: orgNameProp, organizationCode: orgCodeProp }: SidebarProps) {
  const location = useLocation()
  const pathname = location.pathname || "/"
  const navigate = useNavigate()
  const { t } = useLanguage()
  const dispatch = useAppDispatch()

  const authState = useAppSelector((state) => state.auth)
  const user = authState.user
  const selectedRole = authState.selectedRole

  const [isCollapsed, setIsCollapsed] = useState(false)
  const [expandedItems, setExpandedItems] = useState<string[]>([])
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Use values from Redux (Auth State)
  const role = (selectedRole?.RoleName as Role) || roleProp || "Patient"
  const organizationCode = String(selectedRole?.OrganizationId || orgCodeProp || "")
  const organizationName = selectedRole?.OrganizationName || orgNameProp || ""
  const isSystemAdmin = selectedRole?.RoleName === "Yira System Admin"

  const initials = `${user?.FirstName?.charAt(0) || ""}${user?.LastName?.charAt(0) || ""}`.toUpperCase()

  // Get organization-specific branding
  const orgInfo = useMemo(() => {
    const orgMap: Record<string, { name: string; shortName: string; color: string }> = {
      "1": { name: t("Yira Healthcare Systems"), shortName: t("Yira"), color: "blue" },
    }
    const match = orgMap[organizationCode]
    return {
      name: match?.name ?? t(organizationName),
      shortName: match?.shortName ?? organizationName.slice(0, 3).toUpperCase(),
      color: match?.color ?? "blue",
      isParent: isSystemAdmin || organizationCode === "1",
    }
  }, [organizationCode, organizationName, isSystemAdmin, t])

  const getMenuItems = (): MenuItem[] => {
    switch (role) {
      case "Hospital Admin":
      case "Org Admin":
      case "Yira System Admin":
        if (orgInfo.isParent) {
          // Yira System Admin - can manage all organizations
          return [
            { title: t("Dashboard"), href: "/dashboard/admin", icon: Icons.Home },
            {
              title: t("Organizations"),
              href: "/admin/organizations",
              icon: Icons.Building2,
              children: [
                { title: t("All Organizations"), href: "/admin/organizations", icon: Icons.Building2 },
                { title: t("Add Organization"), href: "/admin/organizations/add", icon: Icons.UserPlus },
              ],
            },
            {
              title: t("User Management"),
              href: "/admin/users",
              icon: Icons.Users,
              children: [
                { title: t("All Users"), href: "/admin/users", icon: Icons.Users },
                { title: t("Roles & Permissions"), href: "/admin/users/roles", icon: Icons.Shield },
              ],
            },
            {
              title: t("System"),
              href: "/admin/system",
              icon: Icons.Settings,
              children: [
                { title: t("Analytics"), href: "/admin/analytics", icon: Icons.BarChart3 },
                { title: t("Database"), href: "/admin/database", icon: Icons.Database },
                { title: t("Security"), href: "/admin/security", icon: Icons.Lock },
                { title: t("Configuration"), href: "/admin/config", icon: Icons.Cog },
              ],
            },
            { title: t("AI Insights"), href: "/ai-insights", icon: Icons.Sparkles },
            { title: t("Notifications"), href: "/notifications", icon: Icons.Bell, badge: "3" },
          ]
        } else {
          // Organization Admin - can only manage their organization
          return [
            { title: t("Dashboard"), href: "/dashboard/admin", icon: Icons.Home },
            {
              title: t("Users"),
              href: "/admin/users",
              icon: Icons.Users,
              children: [
                { title: t("All Users"), href: "/admin/users", icon: Icons.Users },
                { title: t("Onboard Members"), href: "/admin/onboard", icon: Icons.UserPlus },
                { title: t("Roles"), href: "/admin/users/roles", icon: Icons.Shield },
              ],
            },
            { title: t("Patients"), href: "/patients", icon: Icons.Users },
            { title: t("Appointments"), href: "/appointments", icon: Icons.Calendar },
            { title: t("Medical Records"), href: "/medical-records", icon: Icons.FileText },
            { title: t("Billing"), href: "/billing", icon: Icons.CreditCard },
            {
              title: t("Documents"),
              href: "/documents",
              icon: Icons.FileSignature,
              children: [
                { title: t("Send Documents"), href: "/documents/send", icon: Icons.Send },
                { title: t("Upload Documents"), href: "/documents/upload", icon: Icons.Upload },
              ],
            },
            {
              title: t("Settings"),
              href: "/admin/settings",
              icon: Icons.Settings,
              children: [
                { title: t("Organization"), href: "/admin/settings/organization", icon: Icons.Building2 },
                { title: t("Security"), href: "/admin/settings/security", icon: Icons.Lock },
                { title: t("Analytics"), href: "/admin/analytics", icon: Icons.BarChart3 },
              ],
            },
            { title: t("AI Insights"), href: "/ai-insights", icon: Icons.Sparkles },
            { title: t("Notifications"), href: "/notifications", icon: Icons.Bell, badge: "5" },
            { title: t("User Settings"), href: "/settings", icon: Icons.Cog },
          ]
        }

      case "Provider":
        return [
          { title: t("Dashboard"), href: "/dashboard/provider", icon: Icons.Home },
          { title: t("Visit Workflow"), href: "/visit-workflow", icon: Icons.Workflow },
          { title: t("Appointments"), href: "/appointments", icon: Icons.Calendar, badge: "12" },
          { title: t("Patients"), href: "/patients", icon: Icons.Users },
          { title: t("Billing"), href: "/billing", icon: Icons.CreditCard },
          {
            title: t("Documents"),
            href: "/documents",
            icon: Icons.FileSignature,
            children: [
              { title: t("Send Documents"), href: "/documents/send", icon: Icons.Send },
              { title: t("Upload Documents"), href: "/documents/upload", icon: Icons.Upload },
            ],
          },
          { title: t("AI Insights"), href: "/ai-insights", icon: Icons.Sparkles },
          { title: t("Notifications"), href: "/notifications", icon: Icons.Bell, badge: "3" },
          { title: t("Settings"), href: "/settings", icon: Icons.Settings },
        ]

      case "Patient":
        return [
          { title: t("Dashboard"), href: "/patient/dashboard", icon: Icons.Home },
          { title: t("Appointments"), href: "/patient/appointments", icon: Icons.Calendar },
          { title: t("Book Appointment"), href: "/patient/book-appointment", icon: Icons.UserPlus },
          { title: t("Health Records"), href: "/patient/health-records", icon: Icons.FileText },
          { title: t("Test Results"), href: "/patient/test-results", icon: Icons.ClipboardList },
          { title: t("Prescriptions"), href: "/patient/prescriptions", icon: Icons.Stethoscope },
          { title: t("Health Tracker"), href: "/patient/health-tracker", icon: Icons.Activity },
          { title: t("Health Assessments"), href: "/patient/health-assessments", icon: Icons.ClipboardList },
          { title: t("Health Education"), href: "/patient/education", icon: Icons.BookOpen },
          { title: t("Messages"), href: "/patient/messages", icon: Icons.MessageSquare, badge: "2" },
          { title: t("Billing"), href: "/patient/billing", icon: Icons.CreditCard },
          { title: t("AI Insights"), href: "/ai-insights", icon: Icons.Sparkles },
          { title: t("Settings"), href: "/settings", icon: Icons.Settings },
          { title: t("Profile"), href: "/patient/profile", icon: Icons.User },
        ]

      case "Front Desk":
        return [
          { title: t("Dashboard"), href: "/dashboard/frontdesk", icon: Icons.Home },
          { title: t("Visit Workflow"), href: "/visit-workflow", icon: Icons.Workflow, badge: "3" },
          { title: t("Appointments"), href: "/appointments", icon: Icons.Calendar, badge: "15" },
          { title: t("Patient Registration"), href: "/patients/register", icon: Icons.UserPlus },
          { title: t("Queue Management"), href: "/queue", icon: Icons.Clock, badge: "8" },
          { title: t("Patients"), href: "/patients", icon: Icons.Users },
          { title: t("Billing"), href: "/billing", icon: Icons.CreditCard },
          {
            title: t("Documents"),
            href: "/documents",
            icon: Icons.FileSignature,
            children: [
              { title: t("Send Documents"), href: "/documents/send", icon: Icons.Send },
              { title: t("Upload Documents"), href: "/documents/upload", icon: Icons.Upload },
            ],
          },
          { title: t("AI Insights"), href: "/ai-insights", icon: Icons.Sparkles },
          { title: t("Notifications"), href: "/notifications", icon: Icons.Bell, badge: "4" },
          { title: t("Settings"), href: "/settings", icon: Icons.Settings },
        ]

      default:
        return []
    }
  }

  const mapApiMenuItem = (item: SidebarMenuItem): MenuItem => ({
    title: item.MenuName,
    href: item.Route || "#", // Default to hash if route is null (for parent menus)
    icon: getIcon(item.Icon),
    children: item.children?.map(child => mapApiMenuItem(child))
  })

  useEffect(() => {
    const fetchSidebarData = async () => {
      if (!selectedRole?.RoleId) {
        // If no selected role yet, use static fallback derived from roleProp
        setMenuItems(getMenuItems())
        setIsLoading(false)
        return
      }

      // 1. Try to use cached data from Redux if available (populated during login)
      if (authState.sidebarMenu && authState.sidebarMenu.length > 0) {
        console.log("Using cached sidebar data from Redux")
        setMenuItems(authState.sidebarMenu.map(item => mapApiMenuItem(item)))
        setIsLoading(false)
        return
      }

      // 2. Otherwise fetch from API
      try {
        setIsLoading(true)
        console.log("Fetching sidebar data from API...")
        const data = await SidebarService.getSidebar(
          selectedRole.RoleId,
          selectedRole.OrganizationId,
          selectedRole.HospitalId
        )

        if (data && data.length > 0) {
          setMenuItems(data.map(item => mapApiMenuItem(item)))
        } else {
          setMenuItems(getMenuItems())
        }
      } catch (err) {
        console.warn("Failed to fetch sidebar from API, using fallback", err)
        setMenuItems(getMenuItems())
      } finally {
        setIsLoading(false)
      }
    }

    fetchSidebarData()
  }, [selectedRole, authState.sidebarMenu, roleProp, t])

  useEffect(() => {
    // Sync expanded state with current pathname
    menuItems.forEach((item) => {
      if (
        item.children?.some((child) =>
          pathname && child.href && pathname.startsWith(child.href)
        )
      ) {
        setExpandedItems((prev) =>
          prev.includes(item.title) ? prev : [...prev, item.title]
        )
      }
    })

    // Precisely scroll to center for the navigated item
    const timer = setTimeout(() => {
      // Find the element that exactly matches our current path
      const activeLeaf = document.querySelector(`[data-nav-path="${pathname}"]`)
      if (activeLeaf) {
        activeLeaf.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "nearest",
        })
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [pathname])

  const toggleExpanded = (title: string) => {
    setExpandedItems((prev) =>
      prev.includes(title) ? [] : [title]
    )
  }

  const isActive = (item: MenuItem): boolean => {
    if (!item || !pathname) return false

    const hrefStr = item.href
    let isMatch = false

    if (hrefStr && hrefStr !== "#") {
      const p = (pathname.split("?")[0] || "").replace(/\/$/, "") || "/"
      const h = (hrefStr.split("?")[0] || "").replace(/\/$/, "") || "/"
      isMatch = p === h || (h !== "/" && p.startsWith(h + "/"))
    }

    if (isMatch) return true

    if (item.children && item.children.length > 0) {
      return item.children.some((child) => isActive(child))
    }

    return false
  }

  const isExpanded = (title: string) => expandedItems.includes(title)

  const renderMenuItem = (item: MenuItem, level = 0) => {
    const hasChildren = item.children && item.children.length > 0
    const expanded = isExpanded(item.title)
    const active = isActive(item)

    return (
      <div key={item.title} className="w-full">
        {hasChildren ? (
          <Button
            variant="ghost"
            title={isCollapsed ? item.title : undefined}
            className={cn(
              "font-normal transition-all duration-300 ease-in-out px-3",
              isCollapsed ? "w-10 h-10 p-0 justify-center mx-auto flex" : "w-full justify-start text-left",
              level > 0 && !isCollapsed && "ml-4 w-[calc(100%-1rem)]",
              "hover:bg-accent hover:text-accent-foreground",
              active && isCollapsed && "bg-primary/20 text-primary",
              active && !isCollapsed && "bg-primary/10 text-primary font-medium hover:bg-primary/20",
            )}
            onClick={() => {
              if (isCollapsed) {
                setIsCollapsed(false)
                setTimeout(() => {
                  setExpandedItems([item.title])
                }, 300)
              } else {
                toggleExpanded(item.title)
              }
            }}
          >
            <item.icon className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-300",
              !isCollapsed && "mr-3",
              active && "text-primary"
            )} />
            {!isCollapsed && (
              <div className="flex items-center flex-1 overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">
                <span className="flex-1 truncate text-sm md:text-[13px] lg:text-sm">{item.title}</span>
                {item.badge && (
                  <Badge
                    variant="secondary"
                    className={cn(
                      "ml-2 h-5 px-1.5 text-xs md:text-[10px] lg:text-xs",
                      active && "bg-blue-200 text-blue-800 border-blue-300"
                    )}
                  >
                    {item.badge}
                  </Badge>
                )}
                {expanded ? <ChevronDown className="ml-2 h-4 w-4" /> : <ChevronRight className="ml-2 h-4 w-4" />}
              </div>
            )}
          </Button>
        ) : (
          <Link to={item.href} className="block w-full" data-nav-path={item.href} onClick={() => setIsMobileOpen(false)}>
            <Button
              variant="ghost"
              title={isCollapsed ? item.title : undefined}
              className={cn(
                "font-normal transition-all duration-300 ease-in-out px-3",
                isCollapsed ? "w-10 h-10 p-0 justify-center mx-auto flex" : "w-full justify-start text-left",
                level > 0 && !isCollapsed && "ml-4 w-[calc(100%-1rem)]",
                "hover:bg-accent hover:text-accent-foreground",
                active && "bg-primary/10 text-primary font-medium hover:bg-primary/20",
              )}
            >
              <item.icon className={cn(
                "h-4 w-4 shrink-0 transition-transform duration-300",
                !isCollapsed && "mr-3",
                active && "text-primary"
              )} />
              {!isCollapsed && (
                <div className="flex items-center flex-1 overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">
                  <span className={cn(
                    "flex-1 truncate text-sm md:text-[13px] lg:text-sm",
                    active && "text-blue-900"
                  )}>
                    {item.title}
                  </span>
                  {item.badge && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "ml-2 h-5 px-1.5 text-xs md:text-[10px] lg:text-xs",
                        active && "bg-blue-200 text-blue-800 border-blue-300"
                      )}
                    >
                      {item.badge}
                    </Badge>
                  )}
                </div>
              )}
            </Button>
          </Link>
        )}
        {hasChildren && expanded && !isCollapsed && (
          <div className="mt-1 space-y-1">
            {item.children?.map((child) => renderMenuItem(child, level + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {!isMobileOpen && (
        <Button
          variant="outline"
          size="sm"
          className="fixed top-4 left-4 z-50 md:hidden bg-transparent"
          onClick={() => setIsMobileOpen(true)}
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}

      {isMobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setIsMobileOpen(false)} />
      )}

      <div
        className={cn(
          "fixed left-0 top-0 z-40 h-full bg-card border-r border-border transition-all duration-300",
          isCollapsed ? "w-16" : "w-64 md:w-52 lg:w-64",
          isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center px-4 border-b border-border overflow-hidden">
            <div className={cn(
              "flex items-center flex-1 transition-all duration-300",
              isCollapsed ? "justify-center" : "space-x-3"
            )}>
              <div
                onClick={() => isCollapsed && setIsCollapsed(false)}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white font-medium transition-all duration-300 shadow-sm relative group cursor-pointer overflow-hidden",
                  isCollapsed && "hover:ring-2 hover:ring-white/40",
                  orgInfo.color === "blue" && "bg-blue-600",
                  orgInfo.color === "red" && "bg-red-600",
                  orgInfo.color === "green" && "bg-green-600",
                  orgInfo.color === "purple" && "bg-purple-600",
                  orgInfo.color === "teal" && "bg-teal-600",
                  orgInfo.color === "orange" && "bg-orange-600",
                )}
              >
                {/* Initials - Hidden on hover when togglable */}
                <span className={cn(
                  "text-sm transition-all duration-300",
                  isCollapsed ? "group-hover:opacity-0 group-hover:scale-75" : "opacity-100"
                )}>
                  {initials || orgInfo.shortName.charAt(0)}
                </span>

                {isCollapsed && !isMobileOpen && (
                  <Menu className="absolute inset-0 m-auto h-4 w-4 opacity-0 group-hover:opacity-100 transition-all duration-300 scale-150 group-hover:scale-100" />
                )}
              </div>
              {!isCollapsed && (
                <div className="flex-1 min-w-0 animate-in fade-in slide-in-from-left-2 duration-300">
                  <h2 className="text-sm md:text-[12px] lg:text-sm font-medium text-foreground truncate">
                    {user?.FirstName ? `${user.FirstName} ${user.LastName || ""}` : t("User")}
                  </h2>
                  <p className="text-xs md:text-[10px] lg:text-xs text-muted-foreground truncate">
                    {role === "Front Desk" ? t("Front Desk") : role === "Provider" ? t("Healthcare Provider") : t(role)}
                  </p>
                </div>
              )}
            </div>
            {isMobileOpen && (
              <Button variant="ghost" size="sm" onClick={() => setIsMobileOpen(false)} className="md:hidden ml-auto border border-border rounded-lg h-8 w-8 p-0 hover:bg-accent text-muted-foreground">
                <X className="h-4 w-4" />
              </Button>
            )}
            {!isCollapsed && !isMobileOpen && (
              <Button variant="ghost" size="sm" onClick={() => setIsCollapsed(!isCollapsed)} className="hidden md:flex shrink-0 ml-2">
                <Menu className="h-4 w-4" />
              </Button>
            )}
          </div>

          {!isCollapsed && (
            <div className="px-5 md:px-3 lg:px-5 py-4 border-b border-slate-100 dark:border-slate-800 animate-in fade-in slide-in-from-left-2 duration-300">
              <div className="text-[10px] md:text-[9px] lg:text-[10px] uppercase font-semibold text-muted-foreground tracking-wider mb-2">{t("Organization")}</div>
              <div className="text-sm md:text-[13px] lg:text-sm font-semibold text-foreground leading-tight truncate">{orgInfo.name || t("Yira Healthcare Systems")}</div>
              <div className="text-[11px] md:text-[10px] lg:text-[11px] font-medium text-muted-foreground mt-0.5 tracking-tight">{organizationCode || "YIRA001"}</div>
              <Badge variant="outline" className="mt-2.5 bg-primary/10 text-primary border-primary/20 font-semibold text-[10px] md:text-[9px] lg:text-[10px] py-0 px-2 h-5">
                {role}
              </Badge>
            </div>
          )}

          {!isCollapsed && (
            <div className="px-4 py-2 border-b border-border animate-in fade-in slide-in-from-left-2 duration-300">
              <GlobalPatientSearch variant="compact" />
            </div>
          )}

          <nav
            className={cn(
              "flex-1 space-y-1 overflow-y-auto scroll-smooth custom-scrollbar",
              isCollapsed ? "p-3" : "p-4 md:p-2.5 lg:p-4",
              isLoading && "animate-pulse"
            )}
          >
            {isLoading && !menuItems.length ? (
              // Simple skeleton for loading
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-10 bg-slate-50 rounded-lg mb-2" />
              ))
            ) : (
              menuItems.map((item) => renderMenuItem(item))
            )}
          </nav>

          <div className={cn("border-t border-border", isCollapsed ? "p-2" : "p-4")}>
            <Separator className="mb-4 bg-border" />
            <div className="space-y-1">
              <Link to="/settings" className="block w-full" onClick={() => setIsMobileOpen(false)}>
                <Button
                  variant="ghost"
                  title={isCollapsed ? t("Settings") : undefined}
                  className={cn(
                    "font-normal transition-all duration-300 ease-in-out px-3",
                    isCollapsed ? "w-10 h-10 p-0 justify-center mx-auto flex" : "w-full justify-start text-left",
                    (isActive({ title: t("Settings"), href: "/settings", icon: Icons.Settings }) || pathname.includes("/settings")) && "bg-primary/10 text-primary font-medium hover:bg-primary/20"
                  )}
                >
                  <Icons.Settings className={cn(
                    "h-4 w-4 shrink-0",
                    !isCollapsed && "mr-3",
                    (isActive({ title: t("Settings"), href: "/settings", icon: Icons.Settings }) || pathname.includes("/settings")) && "text-primary"
                  )} />
                  {!isCollapsed && <span className="text-sm md:text-[13px] lg:text-sm">{t("Settings")}</span>}
                </Button>
              </Link>
              <Button
                type="button"
                variant="ghost"
                title={isCollapsed ? t("Logout") : undefined}
                className={cn(
                  "font-normal transition-all duration-300 ease-in-out px-3 text-red-500 hover:text-red-600 hover:bg-red-500/10",
                  isCollapsed ? "w-10 h-10 p-0 justify-center mx-auto flex" : "w-full justify-start text-left"
                )}
                onClick={() => {
                  dispatch(performLogout())
                  navigate("/login")
                }}
              >
                <Icons.LogOut className={cn("h-4 w-4 shrink-0", !isCollapsed && "mr-3")} />
                {!isCollapsed && <span className="text-sm md:text-[13px] lg:text-sm">{t("Logout")}</span>}
              </Button>
            </div>
          </div>
        </div>
      </div >

      <div className={cn("transition-all duration-300", isCollapsed ? "ml-16" : "ml-64 md:ml-52 lg:ml-64", "md:block hidden")} />
    </>
  )
}
