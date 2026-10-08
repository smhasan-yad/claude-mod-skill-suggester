# claude-mod-skill-suggester

Suggests one of your skills from what you are working on. Local BM25 over each SKILL.md plus recent turns, files in use, per-project `.claude/skill-hints.json` boosts/mutes and click feedback. No model calls, no tokens.

## Install

```bash
claude plugin marketplace add smhasan-yad/claude-mod-skill-suggester
claude plugin install skill-suggester@claude-mod-skill-suggester
```

A new chat or /reload-plugins picks it up. Written for the Windows desktop app and terminal (Claude Code mods API); not tested elsewhere.

## License

MIT. 
