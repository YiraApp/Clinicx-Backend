export const signOut = () => {
    // Clear all authentication & identity data
    localStorage.removeItem("token")
    localStorage.removeItem("userRole")
    localStorage.removeItem("userName")
    localStorage.removeItem("organizationCode")
    localStorage.removeItem("organizationName")
    localStorage.removeItem("isSystemAdmin")

    // Redirect to login page
    window.location.href = "/login"
}
