"""Find what a functional test run needs on this machine, and write it to abdm-ft/env.json.

  python3 -I abdm_env.py workbook --skill SKILL_FOLDER [--in abdm-ft]
  python3 -I abdm_env.py survey   [--run ui|ft|all] [--phr-package PACKAGE] [--refresh]
  python3 -I abdm_env.py install  [--yes]
  python3 -I abdm_env.py python

workbook refuses, exit 4, unless every workbook in the skill's workbook/ folder
has a copy of the same name in abdm-ft/ that opens as a workbook.

survey finds every Python on the machine (PATH, Homebrew, pyenv, conda, uv, any
.venv in the project and abdm-ft/.venv), tests each for openpyxl, Pillow,
python-docx and ReportLab, and picks the newest 3.9 or later with all four, else
the newest 3.9 or later. A tie goes to the one found first. Each interpreter is
asked in isolated mode, from a new empty folder, with only PATH, HOME and LANG
set, so nothing in the project or the environment runs. For a ui run it finds
the browsers the Playwright MCP server can reach: an installed Chrome (the
server's default), Edge, or Playwright's own Chromium. With --phr-package it
checks adb, a device, the app and Maestro. It writes abdm-ft/env.json and exits
0 when everything the run needs is there, else prints the one install and exits
1. A later survey of the same run type and package reuses env.json while its
interpreter still imports the four libraries and, for a ui run, Node and the
browser still answer.

install surveys again, and prints the two commands that create abdm-ft/.venv
from the newest plain Python 3.9 or later it just found outside the project, and
install the four libraries into that venv, then exits 3. Only with --yes, given
after the tester said yes, does it run them. It never reads a command from
env.json, and never installs into the system's Python or the project's own
environment.

python prints the interpreter env.json names, for the workbook writer and the
report: "$(python3 -I abdm-ft/abdm_env.py python)" -I abdm-ft/abdm_report.py ...

Needs Python 3 and nothing else: the survey imports only the standard library.
"""
import sys

if __name__ == "__main__" and not sys.flags.isolated and sys.executable:
    # Run again in isolated mode before importing anything, so a file planted beside
    # this script or on PYTHONPATH is never imported. posix and nt are built in.
    __import__("nt" if sys.platform == "win32" else "posix").execv(
        sys.executable, [sys.executable, "-I"] + sys.argv)

import argparse, glob, json, os, re, shutil, subprocess, tempfile, zipfile
from datetime import datetime, timezone

LIBRARIES = [("openpyxl", "openpyxl"), ("PIL", "pillow"), ("docx", "python-docx"), ("reportlab", "reportlab")]
SEARCH = ["venv", "path", "brew", "pyenv", "conda", "uv"]
NAME = re.compile(r"^python3(\.\d+)?(\.exe)?$")
# Run under each interpreter: its version, whether it is a virtual environment,
# and which of the four libraries import. Written for any Python, so an old one
# answers rather than failing on syntax.
PROBE = r'''
import json, sys
out = {"version": "%d.%d.%d" % tuple(sys.version_info[:3]), "prefix": sys.prefix, "venv": getattr(sys, "base_prefix", sys.prefix) != sys.prefix,
       "libraries": {}, "errors": {}}
for mod in ("openpyxl", "PIL", "docx", "reportlab"):
    try:
        m = __import__(mod)
        out["libraries"][mod] = str(getattr(m, "__version__", None) or getattr(m, "Version", None) or "installed")
    except Exception as e:
        out["errors"][mod] = (type(e).__name__ + ": " + str(e))[:160]
print(json.dumps(out))
'''
# What install runs, and nothing else: no index, no extra argument, no file read.
PIP = ["-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input"]


class Refused(Exception):
    pass


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bindir(prefix):
    """Where a prefix keeps its interpreters."""
    return os.path.join(prefix, "Scripts") if os.name == "nt" else os.path.join(prefix, "bin")


def real(path):
    return os.path.realpath(os.path.abspath(path))


def inside(path, folder):
    path, folder = real(path), real(folder)
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def clean_env():
    """Only what a program needs to start: no PYTHONPATH, PYTHONHOME, PYTHONSTARTUP, PIP_ or anything else."""
    return {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}


def run(cmd, timeout=30, cwd=None):
    """A command with a timeout, a clean environment, and a folder of its own unless one is given."""
    own = None
    if cwd is None:
        own = cwd = tempfile.mkdtemp(prefix="abdm-env-")
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                           cwd=cwd, env=clean_env(), universal_newlines=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except FileNotFoundError:
        return None, "", "no such program: " + str(cmd[0])
    except (OSError, subprocess.SubprocessError) as e:
        return None, "", str(e)
    finally:
        if own:
            shutil.rmtree(own, ignore_errors=True)


def guard(ftdir):
    """Refuse a run folder, a venv or an env.json that is a symlink: what is written there must stay there."""
    for path in (ftdir, os.path.join(ftdir, ".venv"), os.path.join(ftdir, "env.json")):
        if os.path.islink(path):
            raise Refused("refused: " + path + " is a symlink. Make it a plain folder or file, then run this again")


def interpreters_in(folder):
    """The python3 and python3.x files in one folder, python3 first."""
    if not os.path.isdir(folder):
        return []
    try:
        names = sorted(n for n in os.listdir(folder) if NAME.match(n))
    except OSError:
        return []
    return [os.path.join(folder, n) for n in names if os.access(os.path.join(folder, n), os.X_OK)]


def venv_python(folder):
    for name in ("python3", "python", "python.exe"):
        p = os.path.join(bindir(folder), name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return [p]
    return []


def candidates(ftdir, project, search):
    """Every interpreter path, in the order they are preferred, each with where it was found."""
    home = os.path.expanduser("~")
    found = []

    def add(paths, where):
        for p in paths:
            found.append((os.path.abspath(p), where))

    if "venv" in search:
        own = os.path.join(ftdir, ".venv")
        add(venv_python(own), "abdm-ft/.venv")
        for depth in ("", "*", os.path.join("*", "*")):
            for folder in sorted(glob.glob(os.path.join(project, depth, ".venv")) + glob.glob(os.path.join(project, depth, "venv"))):
                if "node_modules" not in folder and real(folder) != real(own):
                    add(venv_python(folder), "project " + os.path.relpath(folder, project))
    if "path" in search:
        for folder in os.environ.get("PATH", "").split(os.pathsep):
            if folder:
                add(interpreters_in(folder), "PATH")
    if "brew" in search:
        for prefix in ("/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"):
            add(interpreters_in(os.path.join(prefix, "bin")), "Homebrew")
            for opt in sorted(glob.glob(os.path.join(prefix, "opt", "python@3*"))):
                add(interpreters_in(os.path.join(opt, "bin")), "Homebrew")
    if "pyenv" in search:
        root = os.environ.get("PYENV_ROOT") or os.path.join(home, ".pyenv")
        for version in sorted(glob.glob(os.path.join(root, "versions", "*"))):
            add(venv_python(version), "pyenv")
    if "conda" in search:
        bases = [os.environ.get("CONDA_PREFIX", "")] + [os.path.join(home, n) for n in
                 ("miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba")] + \
                ["/opt/miniconda3", "/opt/anaconda3", "/opt/homebrew/Caskroom/miniconda/base",
                 "/opt/homebrew/Caskroom/miniforge/base"]
        for base in [b for b in bases if b]:
            add(venv_python(base), "conda")
            for env in sorted(glob.glob(os.path.join(base, "envs", "*"))):
                add(venv_python(env), "conda")
        conda = shutil.which("conda")
        if conda:
            code, out, _ = run([conda, "env", "list", "--json"], timeout=20)
            if code == 0:
                try:
                    for env in json.loads(out).get("envs", []):
                        add(venv_python(env), "conda")
                except ValueError:
                    pass
    if "uv" in search:
        uv = shutil.which("uv")
        if uv:
            code, out, _ = run([uv, "python", "find"], timeout=20)
            if code == 0 and out:
                add([out.splitlines()[-1].strip()], "uv")
        for folder in sorted(glob.glob(os.path.join(home, ".local", "share", "uv", "python", "*"))):
            add(venv_python(folder), "uv")
    seen, ordered = set(), []
    for path, where in found:
        if path not in seen and os.path.isfile(path):
            seen.add(path)
            ordered.append((path, where))
    return ordered


def probe(path):
    """What one interpreter is and holds, or None when it does not answer. Isolated mode first; an
    interpreter that refuses -I is asked with -E -s, which also ignores the environment and user site."""
    for flags in (["-I"], ["-E", "-s"]):
        code, out, _ = run([path] + flags + ["-c", PROBE], timeout=60)
        if code == 0 and out:
            try:
                info = json.loads(out.splitlines()[-1])
            except ValueError:
                continue
            info["missing"] = [dist for mod, dist in LIBRARIES if mod not in info.get("libraries", {})]
            info["flags"] = flags
            return info
    return None


def vtuple(text):
    return tuple(int(x) for x in re.findall(r"\d+", str(text))[:3])


def discover(a):
    """Every interpreter found and probed, each listed once."""
    search = [s for s in a.search.split(",") if s in SEARCH]
    found, same = [], set()
    for path, where in candidates(a.dir, a.project, search):
        info = probe(path)
        # One interpreter reached by two names, such as python3 and python3.12, is listed once.
        key = (real(path), info and info.get("prefix"))
        if info and key not in same:
            same.add(key)
            info.update(path=path, found_in=where)
            found.append(info)
    return found


def choose(found):
    """The newest 3.9 or later with all four libraries, else the newest 3.9 or later. A tie goes to the one found first."""
    usable = [c for c in found if vtuple(c["version"]) >= (3, 9)]
    complete = [c for c in usable if not c["missing"]]
    if complete:
        return max(complete, key=lambda c: vtuple(c["version"])), "the newest Python 3.9 or later with all four libraries"
    if usable:
        best = max(usable, key=lambda c: vtuple(c["version"]))
        return best, "no Python here has all four libraries: the newest 3.9 or later, which lacks " + ", ".join(best["missing"])
    return None, "no Python 3.9 or later on this machine"


def install_base(found, a):
    """The interpreter abdm-ft/.venv is made from: the newest 3.9 or later just probed that is not a virtual
    environment and does not live in the project, unless it is abdm-ft/.venv's own."""
    own = os.path.join(a.dir, ".venv")
    usable = [c for c in found if vtuple(c["version"]) >= (3, 9) and not c.get("venv")
              and os.path.isfile(c["path"]) and (not inside(c["path"], a.project) or inside(c["path"], own))]
    return max(usable, key=lambda c: vtuple(c["version"])) if usable else None


def install_steps(base, ftdir):
    """The two commands that create abdm-ft/.venv and install the four libraries into it, and nowhere else."""
    venv = os.path.abspath(os.path.join(ftdir, ".venv"))
    reportlab = "reportlab<5" if vtuple(base["version"])[:2] == (3, 9) else "reportlab"
    return [[base["path"]] + base.get("flags", ["-I"]) + ["-m", "venv", venv],
            [os.path.join(bindir(venv), "python")] + PIP + ["openpyxl", "pillow", "python-docx", reportlab]]


def shown(steps):
    quote = lambda w: '"' + w + '"' if re.search(r'[\s<>]', w) else w
    return " && ".join(" ".join(quote(w) for w in step) for step in steps)


def browsers():
    """The browsers the Playwright MCP server can launch here, and the --browser value for each."""
    home = os.path.expanduser("~")
    found = []
    chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              os.path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
              "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"]
    edge = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
    for name, option, paths in (("Google Chrome", "chrome", chrome), ("Microsoft Edge", "msedge", edge)):
        hit = next((p for p in paths if os.path.exists(p)), None)
        if hit:
            found.append({"name": name, "path": hit, "browser_option": option})
    caches = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""),
              os.path.join(home, "Library", "Caches", "ms-playwright"), os.path.join(home, ".cache", "ms-playwright"),
              os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright")]
    for cache in [c for c in caches if c and c != "0" and os.path.isdir(c)]:
        builds = sorted(glob.glob(os.path.join(cache, "chromium-*")))
        if builds:
            found.append({"name": "Playwright's Chromium", "path": builds[-1], "browser_option": "chromium"})
            break
    return found


def phr(package):
    """adb, a running device, the app and Maestro, for a PHR app on Android."""
    home = os.path.expanduser("~")
    adb = shutil.which("adb") or next((p for p in [
        os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb"),
        os.path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
        os.path.join(home, "Android", "Sdk", "platform-tools", "adb")] if os.path.isfile(p)), None)
    out = {"adb": adb, "device": False, "package": False, "maestro": shutil.which("maestro") or (
        os.path.join(home, ".maestro", "bin", "maestro") if os.path.isfile(os.path.join(home, ".maestro", "bin", "maestro")) else None)}
    if adb:
        code, text, _ = run([adb, "devices"], timeout=20)
        out["device"] = code == 0 and any(line.strip().endswith("\tdevice") for line in text.splitlines()[1:])
        if out["device"] and package:
            code, text, _ = run([adb, "shell", "pm", "list", "packages", package], timeout=20)
            out["package"] = ("package:" + package) in text.split()
    return out


def node():
    path = shutil.which("node")
    if not path:
        return {"path": None, "version": None, "ready": False}
    code, out, _ = run([path, "--version"], timeout=20)
    version = out if code == 0 else None
    return {"path": path, "version": version, "ready": bool(version) and vtuple(version)[:1] >= (18,)}


def still_holds(env, a):
    """env.json may be reused only for the same run type and PHR package, while the interpreter it names
    still imports all four libraries, and for a ui run Node and the browser still answer."""
    if env.get("missing") or env.get("run") != a.run or env.get("phr_package") != a.phr_package:
        return False
    path = (env.get("python") or {}).get("path")
    if not path or not os.path.isfile(path):
        return False
    info = probe(path)
    if not info or info["missing"] or vtuple(info["version"]) < (3, 9):
        return False
    if a.run in ("ui", "all"):
        browser = env.get("browser") or {}
        if not node()["ready"] or not browser.get("path") or not os.path.exists(browser["path"]):
            return False
    if a.phr_package and not all(phr(a.phr_package).values()):
        return False
    return True


def survey(a):
    guard(a.dir)
    envfile = os.path.join(a.dir, "env.json")
    if os.path.isfile(envfile) and not a.refresh:
        try:
            with open(envfile) as f:
                env = json.load(f)
        except ValueError:
            env = {}
        if still_holds(env, a):
            print("reusing " + envfile + " written " + str(env.get("written")) + ": Python " +
                  env["python"]["version"] + " at " + env["python"]["path"])
            return 0
    found = discover(a)
    chosen, why = choose(found)
    env = {"written": now(), "run": a.run, "phr_package": a.phr_package, "python": None, "why": why,
           "missing": [], "install": None,
           "candidates": [{"path": c["path"], "found_in": c["found_in"], "version": c["version"],
                           "missing": c["missing"], "errors": c.get("errors", {})} for c in found]}
    if chosen:
        env["python"] = {"path": chosen["path"], "found_in": chosen["found_in"], "version": chosen["version"],
                         "libraries": chosen["libraries"]}
        if chosen["missing"]:
            env["missing"] += ["python library " + m for m in chosen["missing"]]
    else:
        env["missing"].append("Python 3.9 or later")
    base = install_base(found, a)
    if base and (not chosen or chosen["missing"]):
        # Shown to the tester only. install never reads it back: it surveys again and builds its own.
        env["install"] = shown(install_steps(base, a.dir))
    if a.run in ("ui", "all"):
        n, b = node(), browsers()
        env["node"] = n
        env["browsers"] = b
        env["browser"] = b[0] if b else None
        if not n["ready"]:
            env["missing"].append("Node 18 or later")
        if not b:
            env["missing"].append("a browser")
            env["browser_install"] = "npx playwright install chromium"
    if a.phr_package:
        p = phr(a.phr_package)
        env["phr"] = p
        for key, what in (("adb", "adb"), ("device", "a running Android device"), ("package", "the app " + a.phr_package),
                          ("maestro", "Maestro")):
            if not p[key]:
                env["missing"].append(what)
    os.makedirs(a.dir, exist_ok=True)
    guard(a.dir)
    with open(envfile, "w") as f:
        json.dump(env, f, indent=1)
    for c in env["candidates"]:
        print("python " + c["version"] + " " + c["path"] + " (" + c["found_in"] + "): " +
              ("all four libraries" if not c["missing"] else "lacks " + ", ".join(c["missing"])))
    print("chosen: " + (env["python"]["path"] if env["python"] else "none") + ": " + why)
    if "browser" in env:
        print("browser: " + (env["browser"]["name"] + " (--browser " + env["browser"]["browser_option"] + ")"
                             if env["browser"] else "none reachable"))
    if "phr" in env:
        print("phr: " + json.dumps(env["phr"]))
    print("wrote " + envfile)
    if not env["missing"]:
        print("ready")
        return 0
    print("missing: " + "; ".join(env["missing"]))
    if env["install"]:
        print("install, after the tester says yes: python3 -I " + os.path.basename(__file__) + " install --yes")
        print("which runs: " + env["install"])
    elif chosen and chosen["missing"]:
        print("no plain Python 3.9 or later outside the project to make abdm-ft/.venv from: "
              "install one from https://www.python.org/downloads, then survey again")
    if not env["python"]:
        print("python: install Python 3.9 or later from https://www.python.org/downloads, then survey again")
    if env.get("browser_install"):
        print("browser, after the tester says yes: " + env["browser_install"])
    return 1


def install(a):
    guard(a.dir)
    found = discover(a)
    chosen, _ = choose(found)
    if chosen and not chosen["missing"]:
        print("nothing for this script to install: " + chosen["path"] + " has all four libraries")
        return 0
    base = install_base(found, a)
    if not base:
        print("no plain Python 3.9 or later outside the project to make abdm-ft/.venv from: "
              "install one from https://www.python.org/downloads", file=sys.stderr)
        return 2
    steps = install_steps(base, a.dir)
    if not a.yes:
        print("not installed. With the tester's yes, run: python3 -I " + os.path.basename(__file__) + " install --yes")
        print("or the commands themselves: " + shown(steps))
        return 3
    os.makedirs(a.dir, exist_ok=True)
    for step, timeout in zip(steps, (300, 900)):
        guard(a.dir)
        print("running: " + shown([step]))
        code, out, err = run(step, timeout=timeout)
        if code != 0:
            print("failed: " + shown([step]) + ": " + (err or out or "exit " + str(code))[-400:], file=sys.stderr)
            return 1
    a.refresh = True
    return survey(a)


def python(a):
    envfile = os.path.join(a.dir, "env.json")
    try:
        with open(envfile) as f:
            path = (json.load(f).get("python") or {}).get("path")
    except (OSError, ValueError):
        path = None
    if not path:
        print("no interpreter in " + envfile + ": run survey first", file=sys.stderr)
        return 2
    print(path)
    return 0


def workbook(a):
    """Refuse unless NHA's workbook, by the name the skill ships it under, is in the run folder and opens."""
    if not a.skill:
        print("workbook needs --skill, the module skill's folder", file=sys.stderr)
        return 2
    shipped = sorted(glob.glob(os.path.join(a.skill, "workbook", "*.xlsx")))
    if not shipped:
        print("refused: " + a.skill + " ships no workbook", file=sys.stderr)
        return 4
    for source in shipped:
        copy = os.path.join(a.within, os.path.basename(source))
        try:
            ok = (os.path.isfile(copy) and not os.path.islink(copy) and
                  "xl/workbook.xml" in zipfile.ZipFile(copy).namelist())
        except (OSError, zipfile.BadZipFile):
            ok = False
        if not ok:
            print("refused: NHA's workbook " + os.path.basename(source) + " is not in " + a.within +
                  ". Copy it there from " + os.path.join(a.skill, "workbook"), file=sys.stderr)
            return 4
        print("workbook: " + copy)
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["survey", "install", "python", "workbook"])
    p.add_argument("--dir", default="abdm-ft", help="the run folder that holds env.json")
    p.add_argument("--project", default=".", help="the project searched for a .venv")
    p.add_argument("--run", choices=["ui", "ft", "all"], default="ui")
    p.add_argument("--phr-package", help="a PHR app on Android: its package name")
    p.add_argument("--refresh", action="store_true", help="survey again even when env.json still holds")
    p.add_argument("--search", default=",".join(SEARCH), help="where to look, of " + ",".join(SEARCH))
    p.add_argument("--yes", action="store_true", help="install: the tester said yes")
    p.add_argument("--skill", help="workbook: the module skill's folder")
    p.add_argument("--in", dest="within", default="abdm-ft", help="workbook: the folder the run reads it from")
    a = p.parse_args()
    try:
        sys.exit({"survey": survey, "install": install, "python": python, "workbook": workbook}[a.action](a))
    except Refused as e:
        print(str(e), file=sys.stderr)
        sys.exit(5)


if __name__ == "__main__":
    main()
