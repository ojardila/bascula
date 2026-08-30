/**
 * Choosing one thing out of a list, with gloves on, in the sun, with a queue
 * watching.
 *
 * The list it replaces was forty 32dp chips in alphabetical order — Material's
 * minimum touch target is 48 — with «Ana Ramírez» eight pixels from «Ana
 * Rendón» and no way to search. Three things changed and each one is a
 * separate complaint from the same afternoon:
 *
 *   - **48dp.** Not 44, not "it looks fine on my phone". The number exists
 *     because a finger is that wide, and a glove does not make it narrower.
 *   - **A box that also takes the card.** `People.byTag` has been in the data
 *     layer the whole time with no screen calling it: a pesador who can read
 *     the carné skips choosing entirely, and everybody else types three
 *     letters and sees two names instead of forty.
 *   - **It collapses once chosen.** Forty chips pushed the weight field below
 *     the fold, so the one number this screen exists to capture was off the
 *     bottom of it. After a choice there is one chip and the field is up where
 *     a thumb already is.
 */

import { useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Chip, TextInput, Text } from "react-native-paper";
import { matches, exactTag, type Findable } from "../pickupChecks.ts";

export interface PickItem extends Findable {
  id: number;
}

interface Props {
  items: PickItem[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** The icon an unchosen row wears. */
  icon: string;
  /** Placeholder for the box. Named for what can be typed into it. */
  searchLabel: string;
  /** What to say when the box matches nobody. */
  emptyLabel: string;
  /**
   * Below this many rows a search box is one more thing to read rather than
   * less. A crew of six is chosen from by looking.
   */
  searchFrom?: number;
}

export default function ChipPicker({
  items,
  value,
  onChange,
  icon,
  searchLabel,
  emptyLabel,
  searchFrom = 8,
}: Props) {
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => items.find((i) => i.id === value) ?? null,
    [items, value],
  );

  const shown = useMemo(
    () => (query ? items.filter((i) => matches(i, query)) : items),
    [items, query],
  );

  function type(next: string) {
    // A card typed whole IS the choice. Exact only — see `exactTag`.
    const hit = exactTag(items, next);
    if (hit) {
      onChange(hit.id);
      setQuery("");
      return;
    }
    setQuery(next);
  }

  // Chosen: one chip, and the rest of the screen back. Tapping it undoes the
  // choice rather than opening a menu, because "wrong person" is the correction
  // being made and it should cost one tap.
  if (selected)
    return (
      <View style={styles.chips}>
        <Chip
          selected
          showSelectedCheck={false}
          icon="check"
          closeIcon="close"
          onClose={() => {
            onChange(null);
            setQuery("");
          }}
          onPress={() => {
            onChange(null);
            setQuery("");
          }}
          style={styles.chip}
          textStyle={styles.chipText}
        >
          {selected.label}
        </Chip>
      </View>
    );

  return (
    <>
      {items.length >= searchFrom && (
        <TextInput
          mode="outlined"
          dense
          label={searchLabel}
          value={query}
          onChangeText={type}
          autoCorrect={false}
          autoCapitalize="none"
          left={<TextInput.Icon icon="magnify" />}
          right={
            query ? <TextInput.Icon icon="close" onPress={() => setQuery("")} /> : undefined
          }
          style={styles.search}
        />
      )}
      {shown.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        <View style={styles.chips}>
          {shown.map((i) => (
            <Chip
              key={i.id}
              showSelectedCheck={false}
              icon={icon}
              onPress={() => {
                onChange(i.id);
                setQuery("");
              }}
              style={styles.chip}
              textStyle={styles.chipText}
            >
              {i.label}
            </Chip>
          ))}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  // 48dp is Material's minimum touch target and this screen is the reason it
  // exists. The gap is 8 so two names never share an edge.
  chip: { height: 48, justifyContent: "center" },
  chipText: { fontSize: 15, lineHeight: 20 },
  search: { marginTop: 8 },
  empty: { opacity: 0.75, marginTop: 10 },
});
