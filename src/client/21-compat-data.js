    // ── 兼容页（/compat-status 的只读投影）──────────────────────────────────────
    // 排布按"先看结论、再看明细"：结论条 → 指标卡 → 阻塞项 → 动作可用性 →
    // 降级能力 → 模块实体 → 命令行提示。回答的是"能不能安全动数据"。
    var OPERATION_LABELS = {
      list: 'compat.op.list', archive: 'compat.op.archive', unarchive: 'compat.op.unarchive',
      batch: 'compat.op.batch', delete: 'compat.op.delete',
    }
    /**
     * 「最近改动」流水里 op 的人类名（0.15.0 B2）。
     *
     * 为什么不直接显示 op 名：`mcpm-set-enabled` 这种内部标识符对用户是一串噪声，而这一栏
     * 回答的问题是「谁做了什么」。表里没有的 op 退回原样显示（少一条不等于报错，
     * 猜一个中文反倒可能说错）。
     */
    // 预设注入边界的行名（2026-09-28 用户裁定）：宿主四个内置预设的 id 换成模式名显示，
    // 复用子智能体 / 场景页同一套词典键（preset.name.*，一个真相源）；不在这张表里的
    // 预设（宿主以后新增的、自建的）仍显示原名。
    var PRESET_MODE_NAME_KEYS = {
      standard: 'preset.name.standard',
      ptc: 'preset.name.ptc',
      minimal: 'preset.name.minimal',
      cordis: 'preset.name.cordis',
    }
    var AUDIT_OP_LABELS = {
      'mcpm-set-enabled': 'compat.audit.op.mcpSwitch',
      'mcpm-set-all': 'compat.audit.op.mcpSwitchAll',
      'mcpm-tool-enabled': 'compat.audit.op.mcpToolSwitch',
      'mcpm-add': 'compat.audit.op.mcpAdd',
      'mcpm-edit': 'compat.audit.op.mcpEdit',
      'mcpm-remove': 'compat.audit.op.mcpRemove',
      'mcpm-import': 'compat.audit.op.mcpImport',
      'mcpm-compact': 'compat.audit.op.mcpCompact',
      'mcpm-note': 'compat.audit.op.mcpNote',
      'mcpm-settings': 'compat.audit.op.mcpSettings',
      'mcpm-restart': 'compat.audit.op.mcpRestart',
      'skill-enable': 'compat.audit.op.skillSwitch',
      'skill-disable': 'compat.audit.op.skillSwitch',
      'skill-set-all': 'compat.audit.op.skillSwitchAll',
      'skill-source-enable': 'compat.audit.op.skillSourceSwitch',
      'skill-source-disable': 'compat.audit.op.skillSourceSwitch',
      'skill-source-remove': 'compat.audit.op.skillSourceRemove',
      'skill-source-restore': 'compat.audit.op.skillSourceRestore',
      'skill-create': 'compat.audit.op.skillSave',
      'skill-update': 'compat.audit.op.skillSave',
      'skill-import': 'compat.audit.op.skillImport',
      'skill-upload': 'compat.audit.op.skillImport',
      'skill-delete': 'compat.audit.op.skillDelete',
      'skill-prefer': 'compat.audit.op.skillPrefer',
      'skill-unprefer': 'compat.audit.op.skillPrefer',
      'skill-trash-restore': 'compat.audit.op.trashRestore',
      'skill-trash-delete': 'compat.audit.op.trashDelete',
      'skill-custom-add': 'compat.audit.op.skillDirAdd',
      'skill-custom-remove': 'compat.audit.op.skillDirRemove',
      'rules-create': 'compat.audit.op.ruleSave',
      'rules-update': 'compat.audit.op.ruleSave',
      'rules-remove': 'compat.audit.op.ruleDelete',
      'rules-restore': 'compat.audit.op.trashRestore',
      'rules-toggle': 'compat.audit.op.ruleSwitch',
      'rules-import': 'compat.audit.op.ruleImport',
      'rules-attach': 'compat.audit.op.ruleAttach',
      'rules-detach': 'compat.audit.op.ruleAttach',
      'rules-trash-remove': 'compat.audit.op.trashDelete',
      'rules-set-index': 'compat.audit.op.ruleIndex',
      'rules-set-active': 'compat.audit.op.memorySwitch',
      'rules-create-scene': 'compat.audit.op.sceneSave',
      'rules-update-scene': 'compat.audit.op.sceneSave',
      'rules-remove-scene': 'compat.audit.op.sceneDelete',
      'rules-rebind-prompt': 'compat.audit.op.sceneRebind',
      'rules-scene-lock': 'compat.audit.op.sceneLock',
      'scene-archive-save': 'compat.audit.op.sceneSave',
      'scene-mode-set': 'compat.audit.op.sceneEnter',
      'scene-trash-restore': 'compat.audit.op.trashRestore',
      'scene-trash-delete': 'compat.audit.op.trashDelete',
      'scene-apply': 'compat.audit.op.engineApply',
      'scene-restore': 'compat.audit.op.engineRestore',
      'subagent-create': 'compat.audit.op.personaSave',
      'subagent-update': 'compat.audit.op.personaSave',
      'subagent-delete': 'compat.audit.op.personaDelete',
      'subagent-import': 'compat.audit.op.personaImport',
      'subagent-toggle': 'compat.audit.op.personaSwitch',
      'subagent-trash-restore': 'compat.audit.op.trashRestore',
      'subagent-trash-delete': 'compat.audit.op.trashDelete',
      'agentsmd-create': 'compat.audit.op.presetSave',
      'agentsmd-update': 'compat.audit.op.presetSave',
      'agentsmd-remove': 'compat.audit.op.presetDelete',
      'agentsmd-import': 'compat.audit.op.presetImport',
      'agentsmd-apply': 'compat.audit.op.presetApply',
      'agentsmd-trash-restore': 'compat.audit.op.trashRestore',
      'agentsmd-trash-delete': 'compat.audit.op.trashDelete',
      // 快捷提示词：与预设分开两套文案（「保存提示词预设」在流水里等于"改了 AGENTS.md 的来源"，
      // 而快捷词一个字节都不碰宿主状态，混着记会让流水读起来不像事实）。
      'quickprompt-create': 'compat.audit.op.quickSave',
      'quickprompt-update': 'compat.audit.op.quickSave',
      'quickprompt-toggle': 'compat.audit.op.quickSwitch',
      'quickprompt-remove': 'compat.audit.op.quickDelete',
      'quickprompt-trash-restore': 'compat.audit.op.trashRestore',
      'quickprompt-trash-delete': 'compat.audit.op.trashDelete',
      'tool-table': 'compat.audit.op.toolTable',
      'inject-settings': 'compat.audit.op.injectSettings',
      'scene-settings': 'compat.audit.op.sceneSettings',
      'backups-clean': 'compat.audit.op.backupsClean',
      'history-archive': 'compat.audit.op.sessionArchive',
      'history-unarchive': 'compat.audit.op.sessionUnarchive',
      'history-delete': 'compat.audit.op.sessionDelete',
      'history-archive-batch': 'compat.audit.op.sessionArchive',
      'history-unarchive-batch': 'compat.audit.op.sessionUnarchive',
      'history-delete-batch': 'compat.audit.op.sessionDelete',
      'history-retention-set': 'compat.audit.op.sessionRetention',
      'history-import': 'compat.audit.op.sessionImport',
      'history-export': 'compat.audit.op.sessionExport',
      'history-workspace-register': 'compat.audit.op.sessionRegister',
    }
    /** 每个操作走哪条路线：仅当有"原生委托"能力可用时才算原生。 */
    function operationRoutes(data) {
      const findings = (data && data.findings) || []
      const byId = {}
      findings.forEach(function (f) { byId[f.id] = f })
      const ok = function (id) { return byId[id] === undefined || byId[id].state === 'ok' }
      const routes = {}
      routes.list = ok('workspace.read-state') && ok('workspace.read-table') && ok('workspace.index-shape') ? 'adapter' : 'none'
      routes.archive = ok('workspace.archive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.unarchive = ok('workspace.unarchive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.batch = ok('workspace.batch-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      // 与服务端 OPERATION_ROUTES 同源（src/compat/probe.ts）：
      //   · delete 不要求 `projection.delete-native` —— 宿主自带删除屏障是可选槽位，
      //     要求它会把 rc.2 上的删除显示成不可用（服务端有意不要求）；
      //   · 但要求 `projection.table-delete` —— 那是运行时的硬前提（表不可删就没法安全删行）。
      routes.delete = ok('workspace.delete-native') ? 'native'
        : (ok('workspace.enqueue') && ok('workspace.set-state') && ok('workspace.index-header')
          && ok('sessions.detach-live') && ok('sessions.cold-announce') && ok('projection.write')
          && ok('projection.table-delete') ? 'adapter' : 'none')
      return routes
    }
