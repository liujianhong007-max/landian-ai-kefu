#include "privilege.h"

#include <windows.h>

#include <array>

namespace privilege {

bool is_administrator() {
    BOOL is_member = FALSE;
    PSID administrators = nullptr;
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0,
                                  &administrators)) {
        return false;
    }
    CheckTokenMembership(nullptr, administrators, &is_member);
    FreeSid(administrators);
    return is_member == TRUE;
}

static void enable_privilege(const wchar_t* name) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) {
        return;
    }

    LUID luid{};
    if (LookupPrivilegeValueW(nullptr, name, &luid)) {
        TOKEN_PRIVILEGES privileges{};
        privileges.PrivilegeCount = 1;
        privileges.Privileges[0].Luid = luid;
        privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        AdjustTokenPrivileges(token, FALSE, &privileges, 0, nullptr, nullptr);
    }
    CloseHandle(token);
}

void enable_launch_privileges() {
    constexpr std::array<const wchar_t*, 4> privileges{
        L"SeAssignPrimaryTokenPrivilege",
        L"SeImpersonatePrivilege",
        L"SeIncreaseQuotaPrivilege",
        L"SeDebugPrivilege",
    };
    for (const auto* name : privileges) {
        enable_privilege(name);
    }
}

}  // namespace privilege
