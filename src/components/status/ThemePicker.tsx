import { useThemeStore } from '@/stores/themeStore';
import { radius, motion, colors } from '@/design/tokens';

export function ThemePicker() {
  const themes = useThemeStore(s => s.themes);
  const activeId = useThemeStore(s => s.activeThemeId);
  const setTheme = useThemeStore(s => s.setTheme);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {themes.map(t => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          title={t.name}
          style={{
            width: t.id === activeId ? 10 : 8,
            height: t.id === activeId ? 10 : 8,
            borderRadius: radius.full,
            background: t.bg === '#000000' ? t.accent : t.bg,
            border: t.id === activeId ? `2px solid ${t.bg === '#000000' ? t.fg : t.accent}` : `1px solid ${colors.outlineGhost}`,
            cursor: 'pointer',
            padding: 0,
            transition: `all ${motion.hover}`,
            opacity: t.id === activeId ? 1 : 0.5,
          }}
        />
      ))}
    </div>
  );
}
