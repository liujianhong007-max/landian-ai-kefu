@echo off
REM ============================================================
REM CdpEnabler.dll 编译脚本
REM 复刻 PddExtend-3.5.7.16.dll 的 CDP 端口启用逻辑
REM
REM 前置条件：
REM   1. 安装 Visual Studio 2022 (含 C++ 桌面开发 workload)
REM   2. 安装 CMake 3.16+
REM
REM 用法：
REM   build.bat              - 编译 Release x64
REM   build.bat debug        - 编译 Debug x64
REM ============================================================

setlocal

set BUILD_TYPE=Release
if /I "%1"=="debug" set BUILD_TYPE=Debug

echo ============================================
echo Building CdpEnabler.dll (%BUILD_TYPE% x64)
echo ============================================

REM 创建 build 目录
if not exist "build" mkdir build
cd build

REM 配置 CMake (x64)
cmake .. -G "Visual Studio 17 2022" -A x64

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] CMake configure failed!
    echo Try: cmake .. -G "Visual Studio 17 2022" -A x64
    cd ..
    exit /b 1
)

REM 编译
cmake --build . --config %BUILD_TYPE%

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed!
    cd ..
    exit /b 1
)

cd ..

echo.
echo ============================================
echo Build succeeded!
echo Output: ..\..\assets\inject\CdpEnabler.dll
echo ============================================
dir /b "..\..\assets\inject\CdpEnabler.dll" 2>nul

endlocal
