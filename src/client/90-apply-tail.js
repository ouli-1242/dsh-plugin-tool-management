
        // 页面组件填进 factory 作用域那个占位对象（导出对象求值时已指向它）。
        // 不要改回 `module.exports.X = ...`：apply 可能在本函数开头提前返回。
        _pages.MCPPage = MCPPage
        _pages.SkillManagerSection = SkillManagerSection
        _pages.PromptsPage = PromptsPage
        _pages.SessionsPage = SessionsPage
        _pages.ScenesPage = ScenesPage
        _pages.SubagentsPage = SubagentsPage
        _pages.MemoryPage = MemoryPage
        _pages.CompatPage = CompatPage
        // 标题旁的版本徽标也导出：其他页面（提示词页）在用它，测试与排版预览需要能单独渲染。
        _pages.VersionBadge = VersionBadgeComponent
        _pages.t = t
        // 纯函数（无状态、可单测）：卡片描述行、场景归属判定、记忆段默认勾选都靠它们，
        // 契约是「描述超长必裁」「记忆段的勾选只认本场景自己的记忆」。测试直接调这几个函数。
        _pages.sceneTileDesc = sceneTileDesc
        _pages.clipText = clipText
        _pages.sceneOfGroup = sceneOfGroup
        _pages.sceneMemoriesOf = sceneMemoriesOf
        _pages.memDefaultPickIds = memDefaultPickIds
        // 常量用函数包一层：测试会把 _pages 的每个值当组件渲染一遍，数字会被 React 当成非法元素类型报警告。
        _pages.sceneDescMax = function () { return SCENE_DESC_MAX }
        _pages.memDescMax = function () { return MEM_DESC_MAX }
      },
    }
    return module.exports
  }
})


