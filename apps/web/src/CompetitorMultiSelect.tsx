import type { Competitor } from './models.js';

interface Props {
  competitors: Competitor[];
  value: string[];
  onChange: (ids: string[]) => void;
}

export function CompetitorMultiSelect({ competitors, value, onChange }: Props) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  }

  return (
    <fieldset className='competitor-picker'>
      <legend>选择对比竞品 <span>请选择 2 个</span></legend>
      {!competitors.length ? <p className='hint'>竞品库为空，请先添加竞品。</p> : (
        <div className='competitor-picker__grid'>
          {competitors.map((item) => {
            const checked = value.includes(item.id);
            return (
              <label className={'competitor-option' + (checked ? ' selected' : '')} key={item.id}>
                <input type='checkbox' checked={checked} disabled={!checked && value.length >= 2} onChange={() => toggle(item.id)} />
                <span><strong>{item.name}</strong><small>{item.website || '未设置官网'}</small></span>
                <em>{checked ? '已选择' : '选择'}</em>
              </label>
            );
          })}
        </div>
      )}
      {!!value.length && <p className='selection-summary'>已选择 {value.length} 个竞品，将只对比这两者。</p>}
    </fieldset>
  );
}
