"""Every piece of Hermes the plugin uses still exists in the Hermes it runs against.

The plugin's calls into Hermes fail soft (dictation reports itself unavailable, narration goes quiet), and the
other tests replace Hermes with fakes, so a Hermes update that removes something would pass them silently.
These tests read the real Hermes checkout's source (found on sys.path, never imported) and check each import,
each attribute read from an imported Hermes module, each declared hook and each ``ctx`` call.

They skip only where no Hermes checkout is on the path (a plain workspace run); the test-box gate has one.
"""
from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

from tests.support import PROJECT_ROOT

HERMES_ROOTS = {"agent", "tools", "hermes_cli", "hermes_state", "hermes_yaml", "hermes_constants", "gateway",
                "cron", "model_tools", "run_agent", "hermes_platform", "utils", "providers", "plugins", "cli",
                "persistence", "persistence_assembly"}
_IMPORT_ERRORS = frozenset({"ImportError", "ModuleNotFoundError"})


def _hermes_root() -> Path | None:
    for entry in sys.path:
        base = Path(entry or ".")
        if (base / "hermes_cli" / "plugins.py").is_file() and (base / "hermes_state.py").is_file():
            return base
    return None


HERMES = _hermes_root()


def _plugin_sources():
    for path in sorted(PROJECT_ROOT.rglob("*.py")):
        rel = path.relative_to(PROJECT_ROOT)
        if rel.parts[0] in ("tests", "__pycache__") or "vendor" in rel.parts:
            continue
        yield rel, ast.parse(path.read_text(encoding="utf-8"))


def _module_file(module: str) -> Path | None:
    base = HERMES / module.replace(".", "/")
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


_defined_cache: dict[Path, set[str]] = {}


def _defined(path: Path) -> set[str]:
    """Top-level names a module defines, re-exports, or exposes via compatibility tables."""
    if path not in _defined_cache:
        names: set[str] = set()

        def visit(body):
            for node in body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    names.add(node.name)
                elif isinstance(node, ast.Assign):
                    target_names = [n.id for t in node.targets for n in ast.walk(t) if isinstance(n, ast.Name)]
                    names.update(target_names)
                    if any(t in ("_REPLACEMENTS", "_LOCAL") for t in target_names) and isinstance(node.value, ast.Dict):
                        names.update(
                            k.value for k in node.value.keys
                            if isinstance(k, ast.Constant) and isinstance(k.value, str)
                        )
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    names.add(node.target.id)
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    names.update((a.asname or a.name).split(".")[0] for a in node.names)
                for field in ("body", "orelse", "finalbody", "handlers"):
                    inner = getattr(node, field, None)
                    if isinstance(inner, list) and not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                                                         ast.ClassDef)):
                        visit(inner)

        visit(ast.parse(path.read_text(encoding="utf-8")).body)
        _defined_cache[path] = names
    return _defined_cache[path]


def _has_name(module: str, name: str) -> bool:
    if _module_file(f"{module}.{name}"):
        return True  # a submodule
    path = _module_file(module)
    return bool(path) and name in _defined(path)


def _catches_import_error(node: ast.Try) -> bool:
    for handler in node.handlers:
        if handler.type is None:
            continue
        types = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
        if any(ast.unparse(t).rpartition(".")[2] in _IMPORT_ERRORS for t in types):
            return True
    return False


def _top_level_import_choices(tree: ast.Module) -> tuple[list[ast.AST], list[list[list[ast.stmt]]]]:
    """Return (non-fallback top-level statements, list of top-level ImportError try/except branch lists)."""
    plain: list[ast.AST] = []
    choices: list[list[list[ast.stmt]]] = []
    for stmt in tree.body:
        if isinstance(stmt, ast.Try) and _catches_import_error(stmt):
            branches = [stmt.body, *(h.body for h in stmt.handlers)]
            choices.append(branches)
            plain.extend(stmt.orelse)
            plain.extend(stmt.finalbody)
        else:
            plain.append(stmt)
    return plain, choices


def _import_problems(rel: Path, nodes: list[ast.AST]) -> list[str]:
    problems: list[str] = []
    for root in nodes:
        for node in ast.walk(root):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                if node.module.split(".")[0] not in HERMES_ROOTS:
                    continue
                if not _module_file(node.module):
                    problems.append(f"{rel}:{node.lineno} module {node.module}")
                    continue
                problems += [f"{rel}:{node.lineno} {node.module}.{a.name}" for a in node.names
                             if not _has_name(node.module, a.name)]
            elif isinstance(node, ast.Import):
                problems += [f"{rel}:{node.lineno} module {a.name}" for a in node.names
                             if a.name.split(".")[0] in HERMES_ROOTS and not _module_file(a.name)]
    return problems


def _attribute_problems(rel: Path, nodes: list[ast.AST], extra_nodes: list[ast.AST] | None = None) -> list[str]:
    aliases: dict[str, str] = {}
    for root in nodes:
        for node in ast.walk(root):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.split(".")[0] in HERMES_ROOTS and _module_file(a.name):
                        aliases[a.asname or a.name] = a.name
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                if node.module.split(".")[0] in HERMES_ROOTS:
                    for a in node.names:
                        if _module_file(f"{node.module}.{a.name}"):
                            aliases[a.asname or a.name] = f"{node.module}.{a.name}"
    problems: list[str] = []
    for root in [*(nodes or []), *(extra_nodes or [])]:
        for node in ast.walk(root):
            if (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id in aliases and not _has_name(aliases[node.value.id], node.attr)):
                problems.append(f"{rel}:{node.lineno} {aliases[node.value.id]}.{node.attr}")
    return problems


@unittest.skipUnless(HERMES, "no Hermes checkout on sys.path")
class HermesSurfaceTest(unittest.TestCase):
    def test_every_hermes_import_resolves(self):
        problems = []
        for rel, tree in _plugin_sources():
            plain, choices = _top_level_import_choices(tree)
            problems.extend(_import_problems(rel, plain))
            for branches in choices:
                branch_problems = [_import_problems(rel, branch) for branch in branches]
                if branch_problems and all(branch_problems):
                    problems.extend(branch_problems[0])
        self.assertEqual(problems, [], "Hermes no longer provides these")

    def test_attributes_read_from_hermes_modules_exist(self):
        problems = []
        for rel, tree in _plugin_sources():
            plain, choices = _top_level_import_choices(tree)
            problems.extend(_attribute_problems(rel, plain))
            for branches in choices:
                branch_problems = [
                    _import_problems(rel, branch) + _attribute_problems(rel, branch, plain)
                    for branch in branches
                ]
                if branch_problems and all(branch_problems):
                    problems.extend(_attribute_problems(rel, branches[0], plain))
        self.assertEqual(sorted(set(problems)), [], "Hermes modules no longer define these")

    def test_declared_hooks_are_valid(self):
        source = (HERMES / "hermes_cli" / "plugins.py").read_text(encoding="utf-8")
        hooks, inside = [], False
        for line in (PROJECT_ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines():
            if line.startswith("provides_hooks:"):
                inside = True
            elif inside and line.strip().startswith("- "):
                hooks.append(line.strip()[2:].strip())
            elif inside and line.strip():
                inside = False
        self.assertTrue(hooks)
        self.assertEqual([h for h in hooks if f'"{h}"' not in source], [], "no longer valid hook names")

    def test_ctx_calls_exist_on_the_plugin_context(self):
        hermes_cli = "\n".join(p.read_text(encoding="utf-8") for p in (HERMES / "hermes_cli").rglob("*.py"))
        calls = set()
        for name in ("__init__.py", "bridge.py"):
            calls |= set(re.findall(r"\bctx\.([a-zA-Z]\w*)\b", (PROJECT_ROOT / name).read_text(encoding="utf-8")))
        self.assertTrue(calls)
        missing = sorted(c for c in calls if not re.search(rf"\bdef {re.escape(c)}\(", hermes_cli))
        self.assertEqual(missing, [], "the plugin context no longer offers these")


if __name__ == "__main__":
    unittest.main()
