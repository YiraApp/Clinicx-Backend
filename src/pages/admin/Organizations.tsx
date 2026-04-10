import React, { useState, useEffect } from "react";
import {
    Building2,
    Plus,
    Search,
    Filter,
    Users,
    UserRound,
    Activity,
    MoreVertical,
    ExternalLink,
    Mail,
    Phone,
    Globe,
    Edit2,
    Trash2,
    CheckCircle2,
    ShieldCheck,
    Building,
    CalendarIcon,
    Loader2,
    AlertCircle
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageTransition } from "@/components/shared/PageTransition";
import { useLanguage } from "@/lib/i18n/language-context";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

import { DashboardHeader } from "@/components/DashboardHeader";
import { useAppDispatch, useAppSelector } from "@/store";
import { fetchRoles } from "@/store/slices/roleSlice";
import { OrganizationService } from "@/services/admin/organization.service";

interface Organization {
    Id: string | number;
    Name: string;
    OrgCode: string;
    OrganizationType?: string;
    Email?: string;
    MobileNumber?: string;
    Address?: string;
    Website?: string;
    Status: boolean | string;
    CreatedAt: string;
    UserCount?: number;
    PatientCount?: number;
    // For legacy compatibility if needed
    id?: string;
    name?: string;
    code?: string;
}

export default function Organizations() {
    const { t } = useLanguage();
    const [searchQuery, setSearchQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState("all");
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [summaryStats, setSummaryStats] = useState({
        totalOrganizations: 0,
        activeOrganizations: 0,
        totalUsers: 0,
        totalPatients: 0
    });
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [pagination, setPagination] = useState({
        page: 1,
        pageSize: 10,
        totalRecords: 0,
        totalPages: 1
    });
    const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);
    const [formData, setFormData] = useState({
        name: "",
        code: "",
        type: "",
        email: "",
        phone: "",
        address: "",
        website: "",
        roleId: "6F92E889-9844-4C8F-A9E7-5A456F12A9C7",
        status: true,
        termsAccepted: false,
    });

    const dispatch = useAppDispatch();
    const { roles: apiRoles } = useAppSelector(state => state.role);
    const [isSaving, setIsSaving] = useState(false);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        if (successMessage || errorMessage) {
            const timer = setTimeout(() => {
                setSuccessMessage(null);
                setErrorMessage(null);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [successMessage, errorMessage]);

    useEffect(() => {
        loadOrganizations(currentPage, pageSize);
    }, [currentPage, pageSize]);

    const loadOrganizations = async (page: number = 1, size: number = 10) => {
        try {
            setLoading(true);
            const response = await OrganizationService.getOrganizations(page, size);
            // Handle new response structure
            if (response) {
                setOrganizations(response.organizationStats || []);
                setSummaryStats({
                    totalOrganizations: response.totalOrganizations || 0,
                    activeOrganizations: response.activeOrganizations || 0,
                    totalUsers: response.totalUsers || 0,
                    totalPatients: response.totalPatients || 0
                });
                if (response.pagination) {
                    const p = response.pagination as any;
                    setPagination({
                        // Use the requested page and size to prevent snapping back
                        // if the server incorrectly returns default metadata values
                        page: page,
                        pageSize: size,
                        totalRecords: p.totalRecords || p.TotalRecords || response.totalOrganizations || 0,
                        totalPages: p.totalPages || p.TotalPages || 0
                    });
                }
            }
        } catch (error) {
            console.error("Failed to load organizations:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (apiRoles.length === 0) {
            dispatch(fetchRoles());
        }
    }, [dispatch, apiRoles.length]);

    const filteredOrganizations = organizations.filter(org => {
        const matchesSearch = (org.Name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
            (org.OrgCode || "").toLowerCase().includes(searchQuery.toLowerCase());
        const matchesType = typeFilter === "all" || (org.OrganizationType || "").toLowerCase() === typeFilter.toLowerCase();
        return matchesSearch && matchesType;
    });

    const handleInputChange = (field: string, value: string | boolean | Date | undefined) => {
        setFormData((prev: any) => ({ ...prev, [field]: value }));
    };

    const handleCreateOrganization = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setErrorMessage(null);
        try {
            const payload = {
                Name: formData.name,
                OrgCode: formData.code,
                OrganizationType: formData.type,
                Email: formData.email,
                MobileNumber: formData.phone,
                Address: formData.address,
                Website: formData.website,
                roleId: formData.roleId,
            };
            const response = await OrganizationService.createOrganization(payload);

            // Reaching here means success because the interceptor would throw on error
            setSuccessMessage(response.statusMessage || t("Organization created and user linked successfully."));
            setIsCreateDialogOpen(false);
            resetForm();
            loadOrganizations(currentPage, pageSize); // Refresh the list
        } catch (error: any) {
            console.error("Failed to create organization:", error);
            setErrorMessage(error.response?.data?.message || error.message || "Failed to create organization");
        } finally {
            setIsSaving(false);
        }
    };

    const handleEditOrganization = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedOrganization) return;

        setIsSaving(true);
        setErrorMessage(null);
        try {
            const payload: any = {
                Id: selectedOrganization.Id,
                Name: formData.name,
                OrganizationType: formData.type,
                Email: formData.email,
                Website: formData.website,
                Address: formData.address,
                Status: formData.status,
            };

            // If phone changed, the API requires MobileNumber and roleId for relocation logic
            if (formData.phone !== selectedOrganization.MobileNumber) {
                payload.MobileNumber = formData.phone;
                payload.roleId = formData.roleId;
            }

            const response = await OrganizationService.updateOrganization(payload);

            setSuccessMessage(response.statusMessage || t("Organization updated successfully."));
            setIsEditDialogOpen(false);
            resetForm();
            loadOrganizations(currentPage, pageSize);
        } catch (error: any) {
            console.error("Failed to update organization:", error);
            setErrorMessage(error.response?.data?.message || error.message || "Failed to update organization");
        } finally {
            setIsSaving(false);
        }
    };

    const resetForm = () => {
        setFormData({
            name: "",
            code: "",
            type: "",
            email: "",
            phone: "",
            address: "",
            website: "",
            roleId: "6F92E889-9844-4C8F-A9E7-5A456F12A9C7",
            status: true,
            termsAccepted: false,
        });
    };

    const openEditDialog = (org: Organization) => {
        setSelectedOrganization(org);
        setFormData({
            name: org.Name,
            code: org.OrgCode,
            type: org.OrganizationType || "",
            email: org.Email || "",
            phone: org.MobileNumber || "",
            address: org.Address || "",
            website: org.Website || "",
            roleId: "6F92E889-9844-4C8F-A9E7-5A456F12A9C7",
            status: org.Status === true || org.Status === "Active",
            termsAccepted: true,
        });
        setIsEditDialogOpen(true);
    };

    const handleDeleteOrganization = (id: string) => {
        if (confirm(t("Are you sure you want to delete this organization? This action cannot be undone."))) {
            console.log("Deleting organization:", id);
            // In a real app, we would remove it from state
        }
    };

    return (
        <PageTransition className="p-6 space-y-6">
            {/* Header Section */}
            <DashboardHeader
                title={t("Organizations Management")}
                subtitle={t("Manage healthcare organizations and facilities across the Yira network")}

            >
                <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
                    <DialogTrigger asChild>
                        <Button className="h-[36px] w-[180px] bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20 flex items-center px-4 transition-all active:scale-95">
                            <Plus className="h-4 w-4 shrink-0" />
                            <span className="flex-1 text-center font-medium text-sm">
                                {t("Add Organization")}
                            </span>
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle className="text-xl font-bold">{t("Create New Organization")}</DialogTitle>
                            <DialogDescription>{t("Add a new healthcare organization to the Yira network")}</DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleCreateOrganization} className="space-y-4 py-4">
                            {errorMessage && (
                                <Alert variant="destructive" className="bg-red-50 border-red-200">
                                    <AlertCircle className="h-4 w-4" />
                                    <AlertDescription className="text-red-800">{errorMessage}</AlertDescription>
                                </Alert>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="name" className="text-sm font-semibold text-slate-900">{t("Organization Name")} *</Label>
                                    <Input
                                        id="name"
                                        value={formData.name}
                                        onChange={(e) => handleInputChange("name", e.target.value)}
                                        placeholder={t("Enter organization name")}
                                        required
                                        className="h-9"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="code" className="text-sm font-semibold text-slate-900">{t("Organization Code")} *</Label>
                                    <Input
                                        id="code"
                                        value={formData.code}
                                        onChange={(e) => handleInputChange("code", e.target.value)}
                                        placeholder="e.g., APL001"
                                        required
                                        className="h-9"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="type" className="text-sm font-semibold text-slate-900">{t("Organization Type")} *</Label>
                                    <Select
                                        value={formData.type}
                                        onValueChange={(value) => handleInputChange("type", value)}
                                    >
                                        <SelectTrigger className="h-9 transition-all focus:ring-1 focus:ring-primary/20">
                                            <SelectValue placeholder={t("Select type")} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="Hospital">{t("Hospital")}</SelectItem>
                                            <SelectItem value="Clinic">{t("Clinic")}</SelectItem>
                                            <SelectItem value="Lab">{t("Laboratory")}</SelectItem>
                                            <SelectItem value="Pharmacy">{t("Pharmacy")}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="website" className="text-sm font-semibold text-slate-900">{t("Website")}</Label>
                                    <Input
                                        id="website"
                                        value={formData.website}
                                        onChange={(e) => handleInputChange("website", e.target.value)}
                                        placeholder="https://www.organization.com"
                                        className="h-9"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="address" className="text-sm font-semibold text-slate-900">{t("Address")} *</Label>
                                <Textarea
                                    id="address"
                                    value={formData.address}
                                    onChange={(e) => handleInputChange("address", e.target.value)}
                                    placeholder={t("Enter complete address")}
                                    required
                                    className="min-h-[80px]"
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="phone" className="text-sm font-semibold text-slate-900">{t("Phone Number")} *</Label>
                                    <Input
                                        id="phone"
                                        value={formData.phone}
                                        onChange={(e) => handleInputChange("phone", e.target.value)}
                                        placeholder="+91-XX-XXXX-XXXX"
                                        required
                                        className="h-9"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="email" className="text-sm font-semibold text-slate-900">{t("Email Address")} *</Label>
                                    <Input
                                        id="email"
                                        type="email"
                                        value={formData.email}
                                        onChange={(e) => handleInputChange("email", e.target.value)}
                                        placeholder="info@organization.com"
                                        required
                                        className="h-9"
                                    />
                                </div>
                            </div>



                            <div className="flex items-center space-x-2 pt-2">
                                <input
                                    type="checkbox"
                                    id="termsAccepted"
                                    checked={formData.termsAccepted}
                                    onChange={(e) => handleInputChange("termsAccepted", e.target.checked)}
                                    className="rounded border-gray-300 h-3.5 w-3.5 text-primary transition-all focus:ring-primary/20"
                                    required
                                />
                                <Label htmlFor="termsAccepted" className="text-sm font-medium">{t("I accept the terms and conditions")} *</Label>
                            </div>

                            <div className="flex justify-end gap-3 pt-6 border-t mt-4">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsCreateDialogOpen(false)}
                                    className="h-9 px-6 font-medium"
                                    disabled={isSaving}
                                >
                                    {t("Cancel")}
                                </Button>
                                <Button
                                    type="submit"
                                    className="h-9 px-6 bg-primary hover:bg-primary/90 text-white font-medium shadow-lg shadow-primary/20 active:scale-95 transition-all"
                                    disabled={isSaving}
                                >
                                    {isSaving ? (
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            {t("Creating...")}
                                        </span>
                                    ) : (
                                        t("Create Organization")
                                    )}
                                </Button>
                            </div>
                        </form>
                    </DialogContent>
                </Dialog>

                {/* Edit Organization Dialog */}
                <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
                    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle className="text-xl font-bold">{t("Edit Organization")}</DialogTitle>
                            <DialogDescription>{t("Update organization information for")} {selectedOrganization?.Name}</DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleEditOrganization} className="space-y-4 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="edit-name" className="text-sm font-semibold text-slate-900">{t("Organization Name")} *</Label>
                                    <Input
                                        id="edit-name"
                                        value={formData.name}
                                        onChange={(e) => handleInputChange("name", e.target.value)}
                                        placeholder={t("Enter organization name")}
                                        required
                                        className="h-9"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="edit-code" className="text-sm font-semibold text-slate-900">{t("Organization Code")} *</Label>
                                    <Input
                                        id="edit-code"
                                        value={formData.code}
                                        onChange={(e) => handleInputChange("code", e.target.value)}
                                        placeholder="e.g., APL001"
                                        required
                                        disabled
                                        className="h-9 bg-muted/50"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="edit-type" className="text-sm font-semibold text-slate-900">{t("Organization Type")} *</Label>
                                    <Select
                                        value={formData.type}
                                        onValueChange={(value) => handleInputChange("type", value)}
                                    >
                                        <SelectTrigger className="h-9 transition-all focus:ring-1 focus:ring-primary/20">
                                            <SelectValue placeholder={t("Select type")} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="Hospital">{t("Hospital")}</SelectItem>
                                            <SelectItem value="Clinic">{t("Clinic")}</SelectItem>
                                            <SelectItem value="Lab">{t("Laboratory")}</SelectItem>
                                            <SelectItem value="Pharmacy">{t("Pharmacy")}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="edit-website" className="text-sm font-semibold text-slate-900">{t("Website")}</Label>
                                    <Input
                                        id="edit-website"
                                        value={formData.website}
                                        onChange={(e) => handleInputChange("website", e.target.value)}
                                        placeholder="https://www.organization.com"
                                        className="h-9"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="edit-address" className="text-sm font-semibold text-slate-900">{t("Address")} *</Label>
                                <Textarea
                                    id="edit-address"
                                    value={formData.address}
                                    onChange={(e) => handleInputChange("address", e.target.value)}
                                    placeholder={t("Enter complete address")}
                                    required
                                    className="min-h-[80px]"
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="edit-phone" className="text-sm font-semibold text-slate-900">{t("Phone Number")} *</Label>
                                    <Input
                                        id="edit-phone"
                                        value={formData.phone}
                                        onChange={(e) => handleInputChange("phone", e.target.value)}
                                        placeholder="+91-XX-XXXX-XXXX"
                                        required
                                        className="h-9"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="edit-email" className="text-sm font-semibold text-slate-900">{t("Email Address")} *</Label>
                                    <Input
                                        id="edit-email"
                                        type="email"
                                        value={formData.email}
                                        onChange={(e) => handleInputChange("email", e.target.value)}
                                        placeholder="info@organization.com"
                                        required
                                        className="h-9"
                                    />
                                </div>
                            </div>



                            <div className="flex flex-col gap-3 py-2">
                                <div className="flex items-center space-x-2">
                                    <input
                                        type="checkbox"
                                        id="edit-status"
                                        checked={formData.status}
                                        onChange={(e) => handleInputChange("status", e.target.checked)}
                                        className="rounded border-gray-300 h-3.5 w-3.5 text-primary transition-all focus:ring-primary/20"
                                    />
                                    <Label htmlFor="edit-status" className="text-sm font-medium">{t("Active Status")}</Label>
                                </div>

                                <div className="flex items-center space-x-2">
                                    <input
                                        type="checkbox"
                                        id="edit-termsAccepted"
                                        checked={formData.termsAccepted}
                                        onChange={(e) => handleInputChange("termsAccepted", e.target.checked)}
                                        className="rounded border-gray-300 h-3.5 w-3.5 text-primary transition-all focus:ring-primary/20"
                                        required
                                    />
                                    <Label htmlFor="edit-termsAccepted" className="text-sm font-medium">{t("I accept the terms and conditions")} *</Label>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-6 border-t mt-4">
                                <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)} className="h-9 px-5" disabled={isSaving}>
                                    {t("Cancel")}
                                </Button>
                                <Button type="submit" className="bg-primary text-white h-9 px-6 shadow-lg shadow-primary/20" disabled={isSaving}>
                                    {isSaving ? (
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            {t("Updating...")}
                                        </span>
                                    ) : (
                                        t("Update Organization")
                                    )}
                                </Button>
                            </div>
                        </form>
                    </DialogContent>
                </Dialog>
            </DashboardHeader>

            {successMessage && (
                <Alert className="bg-emerald-50 border-emerald-200 text-emerald-800 animate-in fade-in slide-in-from-top-4 duration-500">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <AlertDescription>{successMessage}</AlertDescription>
                </Alert>
            )}

            {errorMessage && !isCreateDialogOpen && (
                <Alert variant="destructive" className="bg-red-50 border-red-200 animate-in fade-in slide-in-from-top-4 duration-500">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-red-800">{errorMessage}</AlertDescription>
                </Alert>
            )}

            {/* Stats Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    label={t("Total Organizations")}
                    value={summaryStats.totalOrganizations.toString()}
                    icon={<Building2 className="h-6 w-6" />}
                    color="blue"
                />
                <StatCard
                    label={t("Active Organizations")}
                    value={summaryStats.activeOrganizations.toString()}
                    icon={<Activity className="h-6 w-6" />}
                    color="emerald"
                />
                <StatCard
                    label={t("Total Users")}
                    value={summaryStats.totalUsers.toLocaleString()}
                    icon={<Users className="h-6 w-6" />}
                    color="purple"
                />
                <StatCard
                    label={t("Total Patients")}
                    value={summaryStats.totalPatients.toLocaleString()}
                    icon={<UserRound className="h-6 w-6" />}
                    color="orange"
                />
            </div>

            {/* Filter Section */}
            <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
                <CardContent className="p-4">
                    <div className="flex flex-col md:flex-row gap-4">
                        <div className="relative flex-1 group">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                            <Input
                                placeholder={t("Search organizations...")}
                                className="pl-10 h-9 bg-background/50 border-border focus:ring-1 focus:ring-primary/20"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <div className="flex gap-2">
                            <Select value={typeFilter} onValueChange={setTypeFilter}>
                                <SelectTrigger className="w-[160px] h-9 bg-background/50 border-border">
                                    <div className="flex items-center gap-2">
                                        <Filter className="h-4 w-4 text-muted-foreground" />
                                        <SelectValue placeholder={t("All Types")} />
                                    </div>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t("All Types")}</SelectItem>
                                    <SelectItem value="hospital">{t("Hospital")}</SelectItem>
                                    <SelectItem value="clinic">{t("Clinic")}</SelectItem>
                                    <SelectItem value="lab">{t("Lab")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Table Section */}
            <Card className="border-border shadow-sm overflow-hidden">
                <div className="p-6 border-b border-border bg-muted/30">
                    <h2 className="text-lg font-semibold text-foreground">{t("Organizations Network")}</h2>
                    <p className="text-sm text-muted-foreground">{t("Manage all healthcare organizations in the Yira network")}</p>
                </div>
                <div className="overflow-x-auto min-h-[400px]">
                    <table className="w-full text-left border-collapse table-fixed">
                        <thead>
                            <tr className="border-b border-border bg-muted/20">
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 w-[18%]">{t("Organization")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 w-[12%]">{t("Type")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 w-[23%]">{t("Contact")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 text-center w-[10%]">{t("Users")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 text-center w-[10%]">{t("Patients")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 w-[10%]">{t("Status")}</th>
                                <th className="px-6 py-4 text-sm font-semibold text-slate-900 text-right w-[17%]">{t("Actions")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border relative">
                            <AnimatePresence mode="wait">
                                {loading ? (
                                    <TableSkeleton rows={Math.min(pageSize, 5)} />
                                ) : filteredOrganizations.length === 0 ? (
                                    <motion.tr
                                        key="empty"
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <td colSpan={7} className="px-6 py-12 text-center">
                                            <div className="flex flex-col items-center justify-center gap-2">
                                                <Building2 className="h-8 w-8 text-muted-foreground/40" />
                                                <p className="text-sm font-medium text-muted-foreground">{t("No organizations found")}</p>
                                            </div>
                                        </td>
                                    </motion.tr>
                                ) : (
                                    filteredOrganizations.map((org, index) => (
                                        <motion.tr
                                            key={org.Id}
                                            initial={{ opacity: 0, y: 15 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, x: -10 }}
                                            transition={{
                                                duration: 0.3,
                                                delay: index * 0.03,
                                                ease: "easeOut"
                                            }}
                                            className="hover:bg-accent/50 transition-colors group"
                                        >
                                            <td className="px-6 py-5">
                                                <div className="flex items-center gap-3">
                                                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shrink-0">
                                                        {org.OrganizationType === "Hospital" ? <Building className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="font-medium text-foreground truncate">{org.Name}</span>
                                                        </div>
                                                        <span className="text-sm text-muted-foreground font-mono">{org.OrgCode}</span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <Badge variant="secondary" className="bg-primary/5 text-primary border-primary/10 font-normal">
                                                    {org.OrganizationType || t("General")}
                                                </Badge>
                                            </td>
                                            <td className="px-6 py-5">
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                                                        <Phone className="h-3 w-3" />
                                                        <span>{org.MobileNumber}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                                                        <Mail className="h-3 w-3" />
                                                        <span>{org.Email}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-sm text-primary hover:underline cursor-pointer">
                                                        <Globe className="h-3 w-3" />
                                                        <span>{org.Website}</span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5 text-center">
                                                <div className="inline-flex flex-col">
                                                    <span className="text-sm font-semibold text-foreground">{org.UserCount || 0}</span>
                                                    <span className="text-[11.5px] font-medium text-slate-600">{t("Total Users")}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5 text-center">
                                                <div className="inline-flex flex-col">
                                                    <span className="text-sm font-semibold text-foreground">{org.PatientCount || 0}</span>
                                                    <span className="text-[11.5px] font-medium text-slate-600">{t("Patients")}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <Badge className={cn(
                                                    "px-2.5 py-0.5 rounded-full font-medium text-xs",
                                                    org.Status === true || org.Status === "Active" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" :
                                                        org.Status === "Pending" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" :
                                                            "bg-rose-500/10 text-rose-600 border-rose-500/20"
                                                )}>
                                                    {org.Status === true ? t("Active") : (org.Status === false ? t("Inactive") : (org.Status || t("Pending")))}
                                                </Badge>
                                            </td>
                                            <td className="px-6 py-5 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-all"
                                                        onClick={() => openEditDialog(org)}
                                                    >
                                                        <Edit2 className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 rounded-lg hover:bg-rose-500/10 hover:text-rose-600 transition-all"
                                                        onClick={() => handleDeleteOrganization(String(org.Id))}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg">
                                                        <MoreVertical className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </motion.tr>
                                    ))
                                )}
                            </AnimatePresence>
                        </tbody>
                    </table>
                </div>
            </Card>

            {/* Pagination as standalone */}
            <Pagination
                pagination={pagination}
                onPageChange={(p) => {
                    setCurrentPage(p);
                    setPagination(prev => ({ ...prev, page: p }));
                }}
                onPageSizeChange={(s) => {
                    setPageSize(s);
                    setCurrentPage(1);
                    setPagination(prev => ({ ...prev, pageSize: s, page: 1 }));
                }}
                itemLabel={t("organizations")}
            />

            {/* Floating Action Button (Mobile) */}
            <Button className="md:hidden fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl bg-primary hover:bg-primary/90 text-white p-0">
                <Plus className="h-6 w-6" />
            </Button>
        </PageTransition>
    );
}

function StatCard({ label, value, icon, color }: { label: string, value: string, icon: React.ReactNode, color: string }) {
    const colorMap: any = {
        blue: "text-blue-600 bg-blue-500/10 border-blue-200 dark:border-blue-500/30",
        emerald: "text-emerald-600 bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30",
        purple: "text-purple-600 bg-purple-500/10 border-purple-200 dark:border-purple-500/30",
        orange: "text-orange-600 bg-orange-500/10 border-orange-200 dark:border-orange-500/30",
    }

    return (
        <Card className="border-border/50 shadow-sm overflow-hidden group">
            <CardContent className="p-4">
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-slate-800">{label}</p>
                        <p className="text-2xl font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">{value}</p>
                    </div>
                    <div className={cn("p-2.5 rounded-xl", colorMap[color])}>
                        {icon}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

