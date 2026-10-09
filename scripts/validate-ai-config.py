#!/usr/bin/env python3
"""Offline checks for this repo's small Codex configuration contract (Python 3.11+).

This is not a replacement for Codex's parser or an account/model availability test.
Skill frontmatter intentionally uses only plain names and JSON-quoted descriptions,
a valid YAML subset, so CI needs no additional dependencies.
"""

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = {"gpt-6.1-sol": {"low", "medium", "high"}, "gpt-6-luna": {"high"}}
SKILLS = {"scheduling-regression", "code-change-validation", "security-review", "feature-delivery"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_toml(path):
    with path.open("rb") as stream:
        return tomllib.load(stream)


def check_model(config, label):
    model, effort = config.get("model"), config.get("model_reasoning_effort")
    require(model in MODELS and effort in MODELS[model],
            f"{label}: model/effort outside the documented project choices")


def validate(root=ROOT):
    config = read_toml(root / ".codex/config.toml")
    require(set(config) == {"model", "model_reasoning_effort", "forced_login_method", "agents"},
            "Unexpected or missing project configuration keys; review official docs")
    check_model(config, "primary")
    require(config["forced_login_method"] == "chatgpt", "Use ChatGPT sign-in")
    require(type(config["agents"].get("enabled")) is bool
            and type(config["agents"].get("max_concurrent_threads_per_session")) is int,
            "Agent enablement must be boolean and concurrency must be an integer")
    require(config["agents"] == {"enabled": True, "max_concurrent_threads_per_session": 1},
            "Keep delegation enabled with one active child")

    agent_paths = sorted((root / ".codex/agents").glob("*.toml"))
    require({path.stem for path in agent_paths} == {"qa", "security"},
            "Expected only qa and security agents")
    for path in agent_paths:
        agent = read_toml(path)
        require(set(agent) == {"name", "description", "model", "model_reasoning_effort",
                               "sandbox_mode", "developer_instructions"},
                f"{path.name}: unexpected or missing agent keys")
        require(agent["name"] == path.stem, f"{path.name}: name must match filename")
        require(agent["sandbox_mode"] == "read-only", f"{path.name}: reviewer must be read-only")
        for key in ("description", "developer_instructions"):
            require(isinstance(agent[key], str) and agent[key].strip(), f"{path.name}: empty {key}")
        check_model(agent, path.name)

    paths = sorted((root / ".agents/skills").glob("*/SKILL.md"))
    require({path.parent.name for path in paths} == SKILLS, "Expected the documented project skills")
    for path in paths:
        text = path.read_text(encoding="utf-8")
        match = re.fullmatch(r'---\nname: ([a-z0-9-]{1,64})\ndescription: ("[^\n]*")\n---\n\n(.+)',
                             text, flags=re.DOTALL)
        require(match is not None, f"{path}: expected name and JSON-quoted description frontmatter")
        name, encoded, body = match.groups()
        description = json.loads(encoded)
        require(name == path.parent.name, f"{path}: skill name/folder mismatch")
        require(0 < len(description) <= 240, f"{path}: keep trigger concise")
        require(body.strip() and len(body.split()) <= 350, f"{path}: missing or oversized workflow")
        require("TODO" not in text, f"{path}: unfinished template")

    instructions = (root / "AGENTS.md").read_text(encoding="utf-8")
    require(len(instructions.split()) <= 750, "Keep root AGENTS.md at most 750 words")
    for name in SKILLS:
        require(name in instructions, f"Root routing does not reference {name}")
    for path in ("README.md", "docs/SUPABASE_SETUP.md", "docs/AI_DEVELOPMENT.md",
                 "tests/engine.test.mjs", "tests/gesture.test.mjs", "tests/snapshot.test.mjs",
                 "supabase/tests/access.sql", ".github/workflows/quality.yml"):
        require((root / path).is_file(), f"Missing referenced path: {path}")
    print(f"AI config valid: 2 agents, {len(SKILLS)} skills, {len(instructions.split())} root words")


if __name__ == "__main__":
    try:
        validate()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"AI config validation failed: {error}", file=sys.stderr)
        sys.exit(1)
