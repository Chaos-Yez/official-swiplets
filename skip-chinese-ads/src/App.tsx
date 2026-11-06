import {
  Button,
  DisclosureGroup,
  Form,
  HStack,
  Host,
  Image,
  LabeledContent,
  Menu,
  NavigationDestination,
  NavigationLink,
  NavigationStack,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toggle,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import {
  clipShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  navigationTitle,
  onAppear,
  resizable,
} from "@expo/ui/swift-ui/modifiers";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useEffect, useMemo, useState } from "react";
import { actions, exit, useService } from "@swipt/api/swiplet";
import { preferredLocalizations } from "@swipt/api/localization";

import locales from "../locales.json";
import type extension from "./extension";
import type { RecordedApp, SupportedApp } from "./extension";
import {
  db,
  disabledApps,
  latestRecords,
  setAppEnabled,
  setAppsEnabled,
  setClosePopups,
  setFuzzySkip,
  settings,
  type RecordRow,
} from "./storage";

const table: Record<string, Partial<typeof locales.en>> = locales;
const strings: typeof locales.en = Object.assign(
  {},
  locales.en,
  ...preferredLocalizations(Object.keys(locales))
    .map((localization) => table[localization])
    .reverse(),
);

const { supportedApps, recordedApps } = actions<typeof extension>();

export default function App() {
  const service = useService<typeof extension>();
  const { data: records } = useLiveQuery(latestRecords());
  const { data: settingRows } = useLiveQuery(db().select().from(settings));
  const { data: disabledRows } = useLiveQuery(db().select().from(disabledApps));
  const [apps, setApps] = useState<SupportedApp[] | undefined>(undefined);
  const [recorded, setRecorded] = useState<Map<string, RecordedApp>>(new Map());
  useEffect(() => {
    supportedApps().then(setApps, (error: Error) => console.error(error));
  }, []);
  const recordedIds = useMemo(
    () => [...new Set(records.map((record) => record.app))],
    [records],
  );
  const recordedKey = recordedIds.join("\n");
  useEffect(() => {
    if (recordedIds.length === 0) {
      return;
    }
    recordedApps().then(
      (list) => setRecorded(new Map(list.map((app) => [app.bundleId, app]))),
      (error: Error) => console.error(error),
    );
  }, [recordedKey]);
  const current = settingRows[0];
  const disabledIds = disabledRows.map((row) => row.app);
  const enabledCount =
    apps?.filter((app) => !disabledIds.includes(app.bundleId)).length ?? 0;
  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle(strings.title)]}>
          <Form>
            <Section
              footer={
                service.status === "failed" ? (
                  <Text>{service.error}</Text>
                ) : undefined
              }
            >
              <Toggle
                label={strings.enabled}
                isOn={service.enabled}
                onIsOnChange={(enabled) => service.setEnabled(enabled)}
              />
            </Section>
            <Section
              title={strings.settings}
              footer={<Text>{strings.enabledAppsFooter}</Text>}
            >
              <NavigationLink value="apps">
                <LabeledContent label={strings.enabledApps}>
                  <Text>
                    {apps === undefined ? "" : countApps(enabledCount)}
                  </Text>
                </LabeledContent>
              </NavigationLink>
            </Section>
            <Section footer={<Text>{strings.fuzzySkipFooter}</Text>}>
              <Toggle
                label={strings.fuzzySkip}
                isOn={current?.fuzzySkip ?? false}
                onIsOnChange={(fuzzySkip) => setFuzzySkip(fuzzySkip)}
              />
            </Section>
            <Section footer={<Text>{strings.closePopupsFooter}</Text>}>
              <Toggle
                label={strings.closePopups}
                isOn={current?.closePopups ?? true}
                onIsOnChange={(closePopups) => setClosePopups(closePopups)}
              />
            </Section>
            <Section title={strings.records}>
              {recordedIds.length === 0 ? (
                <Text>{strings.noRecords}</Text>
              ) : (
                recordedIds.map((bundleId) => (
                  <NavigationLink key={bundleId} value={`records/${bundleId}`}>
                    <AppRow
                      name={recorded.get(bundleId)?.name ?? bundleId}
                      icon={recorded.get(bundleId)?.icon}
                      detail={
                        records.find((record) => record.app === bundleId)?.fuzzy
                          ? strings.fuzzyMatch
                          : strings.adaptedApp
                      }
                    />
                  </NavigationLink>
                ))
              )}
            </Section>
          </Form>
          <Toolbar.Content>
            <ToolbarItem placement="topBarLeading">
              <Button
                label={strings.back}
                systemImage="chevron.left"
                onPress={exit}
              />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
        <NavigationDestination value="apps">
          <EnabledApps disabledApps={disabledIds} onLoad={setApps} />
        </NavigationDestination>
        {recordedIds.map((bundleId) => (
          <NavigationDestination key={bundleId} value={`records/${bundleId}`}>
            <AppRecords
              name={recorded.get(bundleId)?.name ?? bundleId}
              records={records.filter((record) => record.app === bundleId)}
            />
          </NavigationDestination>
        ))}
      </NavigationStack>
    </Host>
  );
}

const caption = [
  font({ textStyle: "caption" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

const countApps = (count: number) =>
  (count === 1 ? strings.appCount : strings.appsCount).replace(
    "{count}",
    count.toLocaleString(),
  );

const duration = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms).toLocaleString()} ms`
    : `${(ms / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;

const steps = (record: RecordRow): [string, number][] => {
  const marks: [string, number | null][] = [
    [strings.timingDetected, record.appeared === null ? null : record.detected],
    [strings.timingTapped, record.ms + (record.tapMs ?? 0)],
    [strings.timingGone, record.gone],
  ];
  let reached = record.appeared ?? record.detected ?? record.ms;
  return marks.flatMap(([label, mark]): [string, number][] => {
    if (mark === null) {
      return [];
    }
    const step = mark - reached;
    reached = mark;
    return [[label, step]];
  });
};

const clock = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const dayOf = (time: number) => {
  const date = new Date(time);
  return [date.getFullYear(), date.getMonth(), date.getDate()].join("-");
};

const dayTitle = (time: number) => {
  const now = new Date();
  const date = new Date(time);
  const days = Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
      86_400_000,
  );
  if (days === 0) {
    return strings.today;
  }
  if (days === 1) {
    return strings.yesterday;
  }
  return date.toLocaleDateString(undefined, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
    weekday: "long",
  });
};

function AppRow({
  name,
  icon,
  detail,
}: {
  name: string;
  icon?: string;
  detail: string;
}) {
  return (
    <HStack spacing={12}>
      {icon === undefined ? undefined : (
        <Image
          uiImage={icon}
          modifiers={[
            resizable(),
            frame({ width: 40, height: 40 }),
            clipShape("roundedRectangle", 9),
          ]}
        />
      )}
      <VStack alignment="leading" spacing={2}>
        <Text>{name}</Text>
        <Text modifiers={caption}>{detail}</Text>
      </VStack>
    </HStack>
  );
}

function AppRecords({ name, records }: { name: string; records: RecordRow[] }) {
  const days: { day: string; records: RecordRow[] }[] = [];
  for (const record of records) {
    const day = dayOf(record.time);
    const last = days.at(-1);
    if (last?.day === day) {
      last.records.push(record);
    } else {
      days.push({ day, records: [record] });
    }
  }
  return (
    <Toolbar modifiers={[navigationTitle(name)]}>
      <Form>
        {days.map(({ day, records: entries }) => (
          <Section key={day} title={dayTitle(entries[0].time)}>
            {entries.map((record) => (
              <DisclosureGroup key={record.id}>
                <DisclosureGroup.Label>
                  <HStack>
                    <VStack alignment="leading" spacing={2}>
                      <Text>
                        {record.kind === "close"
                          ? strings.popupAd
                          : strings.splashAd}
                      </Text>
                      <Text modifiers={caption}>
                        {record.kind === "close"
                          ? clock(record.time)
                          : `${clock(record.time)} · ${record.quick ? strings.quickSkip : strings.firstSkip}`}
                      </Text>
                    </VStack>
                    <Spacer />
                    <Text
                      modifiers={[
                        foregroundStyle({
                          type: "hierarchical",
                          style: "secondary",
                        }),
                        monospacedDigit(),
                      ]}
                    >
                      {duration(
                        steps(record).reduce((sum, [, step]) => sum + step, 0),
                      )}
                    </Text>
                  </HStack>
                </DisclosureGroup.Label>
                {steps(record).map(([label, step]) => (
                  <LabeledContent key={label} label={label}>
                    <Text modifiers={[monospacedDigit()]}>
                      {duration(step)}
                    </Text>
                  </LabeledContent>
                ))}
              </DisclosureGroup>
            ))}
          </Section>
        ))}
      </Form>
    </Toolbar>
  );
}

function EnabledApps({
  disabledApps: disabledIds,
  onLoad,
}: {
  disabledApps: string[];
  onLoad: (apps: SupportedApp[]) => void;
}) {
  const [apps, setApps] = useState<SupportedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setApps(null);
    setError(null);
    supportedApps().then(
      (list) => {
        setApps(list);
        onLoad(list);
      },
      (failure: Error) => setError(failure.message),
    );
  };
  const listed = apps?.map((app) => app.bundleId) ?? [];
  const allEnabled = listed.every((id) => !disabledIds.includes(id));
  return (
    <Toolbar modifiers={[navigationTitle(strings.enabledApps), onAppear(load)]}>
      <Form>
        {error !== null ? (
          <Section>
            <Text>{error}</Text>
          </Section>
        ) : apps === null ? (
          <Section>
            <ProgressView />
          </Section>
        ) : apps.length === 0 ? (
          <Section>
            <Text>{strings.noApps}</Text>
          </Section>
        ) : (
          <Section>
            {apps.map((app) => (
              <Toggle
                key={app.bundleId}
                isOn={!disabledIds.includes(app.bundleId)}
                onIsOnChange={(enabled) => setAppEnabled(app.bundleId, enabled)}
              >
                <HStack spacing={12}>
                  <Image
                    uiImage={app.icon}
                    modifiers={[
                      resizable(),
                      frame({ width: 40, height: 40 }),
                      clipShape("roundedRectangle", 9),
                    ]}
                  />
                  <VStack alignment="leading" spacing={2}>
                    <Text>{app.name}</Text>
                    <Text modifiers={caption}>
                      {app.version === undefined
                        ? app.bundleId
                        : `${app.bundleId} · ${app.version}`}
                    </Text>
                  </VStack>
                </HStack>
              </Toggle>
            ))}
          </Section>
        )}
      </Form>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Menu
            label={strings.more}
            systemImage="ellipsis"
            modifiers={[disabled(listed.length === 0)]}
          >
            {allEnabled ? (
              <Button
                label={strings.deselectAll}
                onPress={() => setAppsEnabled(listed, false)}
              />
            ) : (
              <Button
                label={strings.selectAll}
                onPress={() => setAppsEnabled(listed, true)}
              />
            )}
          </Menu>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}
