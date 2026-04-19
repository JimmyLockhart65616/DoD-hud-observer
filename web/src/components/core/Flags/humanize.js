export function humanizeFlagName(name) {
    if (!name) return '';
    return name
        .replace(/^POINT_/i, '')
        .replace(/_/g, ' ')
        .split(' ')
        .map(w => w.length <= 3
            ? w.toUpperCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        )
        .join(' ');
}
