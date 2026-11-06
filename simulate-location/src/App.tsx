import {
  Alert,
  BottomSheet,
  Button,
  Group,
  Host,
  List,
  Menu,
  NavigationStack,
  RNHostView,
  Text,
  TextField,
  Toolbar,
  ToolbarItem,
  useNativeState,
  VStack,
  ZStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  ignoreSafeArea,
  keyboardType,
  labelStyle,
  monospacedDigit,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
  searchable,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { AppleMaps } from "expo-maps";
import { useEffect, useRef, useState } from "react";
import { actions, exit } from "@swipt/api/swiplet";
import { preferredLocalizations } from "@swipt/api/localization";
import { searchPlaces } from "@swipt/api/maps";

import locales from "../locales.json";
import {
  parseCoordinates,
  toGPS,
  toMap,
  type Coordinates,
} from "./coordinates";
import type extension from "./extension";

const table: Record<string, Partial<typeof locales.en>> = locales;
const strings: typeof locales.en = Object.assign(
  {},
  locales.en,
  ...preferredLocalizations(Object.keys(locales))
    .map((localization) => table[localization])
    .reverse(),
);

const simulated = actions<typeof extension>();

const placeZoom = 15;
const searchDelayMs = 300;

const useSimulation = () => {
  const [initial, setInitial] = useState<Coordinates | null | undefined>(
    undefined,
  );
  const [simulating, setSimulating] = useState(false);
  const active = useRef(false);
  const queue = useRef(Promise.resolve());
  const enqueue = (task: () => Promise<void>) => {
    queue.current = queue.current.then(task).catch(reportError);
  };
  const apply = async (location: Coordinates | null) => {
    await simulated.set(location && toGPS(location));
    active.current = location !== null;
    setSimulating(location !== null);
  };
  useEffect(() => {
    simulated.get().then(
      (gps) => {
        active.current = gps !== null;
        setSimulating(gps !== null);
        setInitial(gps && toMap(gps));
      },
      (error: Error) => {
        reportError(error);
        setInitial(null);
      },
    );
  }, []);
  return {
    initial,
    simulating,
    start: (location: Coordinates) => enqueue(() => apply(location)),
    stop: () => enqueue(() => apply(null)),
    move: (location: Coordinates) =>
      enqueue(async () => {
        if (active.current) {
          await apply(location);
        }
      }),
  };
};

export default function App() {
  const simulation = useSimulation();
  const map = useRef<AppleMaps.MapView>(null);
  const [chosen, setChosen] = useState<Coordinates | null>(null);
  const [entering, setEntering] = useState(false);
  const [coordinates, setCoordinates] = useState("");
  const [searching, setSearching] = useState(false);
  const { initial } = simulation;
  useEffect(() => {
    if (initial === null) {
      map.current?.setCameraPosition().catch(reportError);
    }
  }, [initial]);
  if (initial === undefined) {
    return null;
  }
  const pin = chosen ?? initial;
  const choose = (location: Coordinates) => {
    setChosen(location);
    simulation.move(location);
  };
  const reveal = (location: Coordinates) => {
    choose(location);
    map.current
      ?.setCameraPosition({ coordinates: location, zoom: placeZoom })
      .catch(reportError);
  };
  const entered = parseCoordinates(coordinates);
  const gps = pin === null ? null : toGPS(pin);
  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar
          modifiers={[
            navigationTitle(strings.title),
            navigationBarTitleDisplayMode("inline"),
          ]}
        >
          <Alert
            title={strings.enterCoordinates}
            isPresented={entering}
            onIsPresentedChange={setEntering}
          >
            <Alert.Trigger>
              <ZStack>
                <Group modifiers={[ignoreSafeArea()]}>
                  <RNHostView>
                    <AppleMaps.View
                      ref={map}
                      cameraPosition={
                        initial === null
                          ? undefined
                          : { coordinates: initial, zoom: placeZoom }
                      }
                      markers={
                        pin === null
                          ? []
                          : [
                              {
                                id: "pin",
                                coordinates: pin,
                                systemImage: "mappin",
                              },
                            ]
                      }
                      properties={{
                        isMyLocationEnabled: true,
                        selectionEnabled: false,
                      }}
                      uiSettings={{ togglePitchEnabled: false }}
                      onMapClick={(event) =>
                        choose(event.coordinates as Coordinates)
                      }
                    />
                  </RNHostView>
                </Group>
                <BottomSheet
                  isPresented={searching}
                  onIsPresentedChange={setSearching}
                >
                  <Group modifiers={[presentationDetents(["medium", "large"])]}>
                    <SearchPlaces
                      onChoose={([latitude, longitude]) => {
                        setSearching(false);
                        reveal({ latitude, longitude });
                      }}
                    />
                  </Group>
                </BottomSheet>
              </ZStack>
            </Alert.Trigger>
            <Alert.Actions>
              <TextField
                placeholder={strings.coordinates}
                onTextChange={setCoordinates}
                modifiers={[keyboardType("numbers-and-punctuation")]}
              />
              <Button label={strings.cancel} role="cancel" onPress={() => {}} />
              <Button
                label={strings.done}
                onPress={() => reveal(toMap(entered!))}
                modifiers={[disabled(entered === null)]}
              />
            </Alert.Actions>
          </Alert>
          <Toolbar.Content>
            <ToolbarItem placement="topBarLeading">
              <Button
                label={strings.back}
                systemImage="chevron.left"
                onPress={exit}
              />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Menu
                label={strings.more}
                systemImage="ellipsis"
                modifiers={[labelStyle("iconOnly")]}
              >
                <Button
                  label={strings.search}
                  systemImage="magnifyingglass"
                  onPress={() => setSearching(true)}
                />
                <Button
                  label={strings.enterCoordinates}
                  systemImage="number"
                  onPress={() => setEntering(true)}
                />
              </Menu>
            </ToolbarItem>
            <ToolbarItem placement="bottomBar">
              <Button
                label={simulation.simulating ? strings.stop : strings.start}
                onPress={
                  simulation.simulating
                    ? simulation.stop
                    : () => simulation.start(pin!)
                }
                modifiers={[
                  buttonStyle("glassProminent"),
                  disabled(pin === null && !simulation.simulating),
                  ...(simulation.simulating ? [tint("red")] : []),
                ]}
              />
            </ToolbarItem>
            <ToolbarItem placement="bottomBar">
              <Text
                modifiers={[font({ textStyle: "caption" }), monospacedDigit()]}
              >
                {gps === null
                  ? strings.hint
                  : `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`}
              </Text>
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      </NavigationStack>
    </Host>
  );
}

function SearchPlaces({
  onChoose,
}: {
  onChoose: (coordinate: [latitude: number, longitude: number]) => void;
}) {
  const query = useNativeState("");
  const [text, setText] = useState("");
  const [places, setPlaces] = useState<
    Awaited<ReturnType<typeof searchPlaces>>
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(text, { signal: controller.signal }).then(
        setPlaces,
        (error: Error) => {
          if (error.name !== "AbortError") {
            reportError(error);
          }
        },
      );
    }, searchDelayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);
  return (
    <NavigationStack>
      <List
        modifiers={[
          navigationTitle(strings.search),
          navigationBarTitleDisplayMode("inline"),
          searchable(query, {
            placement: "navigationBarDrawer",
            onChange: setText,
          }),
        ]}
      >
        {places.map((place, index) => (
          <Button
            key={index}
            onPress={() => onChoose(place.coordinate)}
            modifiers={[buttonStyle("plain")]}
          >
            <VStack alignment="leading">
              <Text>{place.name ?? ""}</Text>
              <Text
                modifiers={[
                  font({ textStyle: "subheadline" }),
                  foregroundStyle({ type: "hierarchical", style: "secondary" }),
                ]}
              >
                {place.address ?? ""}
              </Text>
            </VStack>
          </Button>
        ))}
      </List>
    </NavigationStack>
  );
}
