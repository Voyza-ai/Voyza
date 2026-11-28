/**
 * Blue (the text assistant) saves a texted YES on the owner's behalf. An
 * owner's open tab normally skips session saves as its own echoes; it must
 * apply Blue's, once, or its next autosave writes the older copy over it.
 */
import { ownerShouldApplySessionSave, withoutTextSaveMark } from '@/lib/tripCollab';

describe('ownerShouldApplySessionSave', () => {
  it("applies a save Blue made, once", () => {
    const s = { savedVia: 'text', textSaveId: 'id-1', cities: [] };
    expect(ownerShouldApplySessionSave(s, null)).toBe('id-1');
    expect(ownerShouldApplySessionSave(s, 'id-1')).toBeNull();
    expect(ownerShouldApplySessionSave({ ...s, textSaveId: 'id-2' }, 'id-1')).toBe('id-2');
  });

  it("skips the owner's own saves (no mark), and malformed marks", () => {
    expect(ownerShouldApplySessionSave({ cities: [] }, null)).toBeNull();
    expect(ownerShouldApplySessionSave({ savedVia: 'canvas', textSaveId: 'x' }, null)).toBeNull();
    expect(ownerShouldApplySessionSave({ savedVia: 'text' }, null)).toBeNull();
    expect(ownerShouldApplySessionSave(null, null)).toBeNull();
  });
});

describe('withoutTextSaveMark', () => {
  it('drops only the mark', () => {
    expect(withoutTextSaveMark({ savedVia: 'text', textSaveId: 'x', trip: { title: 'T' }, cities: [1] })).toEqual({ trip: { title: 'T' }, cities: [1] });
    expect(withoutTextSaveMark({} as any)).toEqual({});
  });
});
