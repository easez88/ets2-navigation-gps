/**
 * scripts/buildGraph.ts
 *
 * Usage:
 *   npx ts-node app/scripts/buildGraph.ts ./public/geojson/roadnetwork.geojson ./public/roadnetwork
 *
 *
 * - This script:
 *   * builds an rbush boundingbox of features to find intersecting lines
 *   * uses turf.lineIntersect to find intersection points between nearby features
 *   * splits each LineString into multiple points and segments. (0,3),(3, 2) turns into (0,3) -> (3,2)
 *   * sorts split points along the line (using turf.nearestPointOnLine .properties.location)
 *   * creates three files that replace the roadnetwork geojson for better performance.
 *
 * - TL;DR:
 *   * Builds a graph from a geojson containing LineStrings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import RBush from "rbush";
import * as turf from "@turf/turf";
import path from "path";
import type { Node, Edge, Coord } from "../assets/utils/routing/graphTypes.ts";
import { haversine } from "../assets/utils/routing/helpers.ts";

interface InputFeature {
    type: "Feature";
    properties: Record<string, any>;
    geometry: {
        type: "LineString";
        coordinates: Coord[];
    };
}

interface InputGeoJSON {
    type: "FeatureCollection";
    features: InputFeature[];
}

interface BBoxItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    idx: number;
}

interface PointWithDist {
    coord: Coord;
    locKm: number;
}

const roadTypeMap: Record<string, number> = {
    local: 0,
    freeway: 1,
    divided: 2,
    roundabout: 3,
    ferry: 4,
};

const COORD_MAX_DECIMALS = 5;
function coordKey(c: Coord) {
    return `${c[0].toFixed(COORD_MAX_DECIMALS)},${c[1].toFixed(COORD_MAX_DECIMALS)}`;
}

function distToSegment(p: Coord, v: Coord, w: Coord) {
    const l2 = Math.pow(v[0] - w[0], 2) + Math.pow(v[1] - w[1], 2);
    if (l2 === 0) return { dist: haversine(p, v) / 1000, pos: v };

    let t =
        ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
    t = Math.max(0, Math.min(1, t));

    const projection: Coord = [
        v[0] + t * (w[0] - v[0]),
        v[1] + t * (w[1] - v[1]),
    ];

    return {
        dist: haversine(p, projection) / 1000,
        pos: projection,
        t: t, // fractional distance along segment
    };
}

interface SegmentBBox extends BBoxItem {
    vIdx: number; // index of the start vertex in the road
}

function storeFeaturePoints(features: InputFeature[]): PointWithDist[][] {
    const featureMetadata = features.map((f) =>
        getLineMetadata(f.geometry.coordinates),
    );

    const splitPoints: PointWithDist[][] = features.map((f, i) => {
        const meta = featureMetadata[i]!;
        return f.geometry.coordinates.map((c, idx) => ({
            coord: c,
            locKm: meta.distances[idx]!,
        }));
    });

    console.log("Building Segment-level spatial index...");
    const tree = new RBush<SegmentBBox>();

    for (let i = 0; i < features.length; i++) {
        const coords = features[i].geometry.coordinates;
        for (let j = 0; j < coords.length - 1; j++) {
            const p1 = coords[j]!;
            const p2 = coords[j + 1]!;
            tree.insert({
                minX: Math.min(p1[0], p2[0]),
                minY: Math.min(p1[1], p2[1]),
                maxX: Math.max(p1[0], p2[0]),
                maxY: Math.max(p1[1], p2[1]),
                idx: i,
                vIdx: j,
            });
        }
    }

    return splitPoints;
}

/* Creates a line from features that gets simplified ->
-> from all the points that are `splitting` the line we create an array ->
-> we create another array containing the point coords and the distance from the coords[0] (start) of the line ->
-> by doing so we will compare the distances and make sure that when we split the points into segments they are in order ->
-> because there is a chance that in the line we havent stored the start or end key, we verify that and add them if they are not already there. ->
-> sort the pointsWithDIstance in order. ->
-> we cleanup the nodes (if some are very close to eachother) -> 
-> we create nodes for each point with distance that is ordered ->
-> we create edges from node to node + 1.
*/

//// CLEANUP IF POINTS ARE TOO CLOSE TO EACHOTHER (OPTIONAL)
function cleanUpPoints(points: PointWithDist[]) {
    // Sort by location along the line
    points.sort((a, b) => a.locKm - b.locKm);

    const cleaned: Coord[] = [];
    let lastLoc = -1;
    for (const item of points) {
        // Skip points that are effectively the same location (within 1mm)
        if (Math.abs(item.locKm - lastLoc) < 0.000001) continue;
        cleaned.push(item.coord);
        lastLoc = item.locKm;
    }
    return cleaned;
}

function getBearing(start: Coord, end: Coord) {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const startLat = toRad(start[1]);
    const startLng = toRad(start[0]);
    const endLat = toRad(end[1]);
    const endLng = toRad(end[0]);

    const y = Math.sin(endLng - startLng) * Math.cos(endLat);
    const x =
        Math.cos(startLat) * Math.sin(endLat) -
        Math.sin(startLat) * Math.cos(endLat) * Math.cos(endLng - startLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function getLineMetadata(coordinates: Coord[]) {
    const distances: number[] = [0];
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += haversine(coordinates[i - 1]!, coordinates[i]!) / 1000;
        distances.push(total);
    }
    return { distances, totalLength: total };
}

function createNodesAndEdges(
    features: InputFeature[],
    allSplitPoints: PointWithDist[][],
) {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const nodeMap = new Map<string, number>();
    const nodeTopology = new Map<
        number,
        { fIdx: number; isStart: boolean; bearing: number }[]
    >();

    function getOrCreateNodeId(coord: Coord): number {
        const k = coordKey(coord);
        if (nodeMap.has(k)) return nodeMap.get(k)!;
        const id = nodes.length;
        const lng = Number(coord[0].toFixed(COORD_MAX_DECIMALS));
        const lat = Number(coord[1].toFixed(COORD_MAX_DECIMALS));
        nodes.push({ id, lng, lat });
        nodeMap.set(k, id);
        return id;
    }

    const processedFeatures: Coord[][] = new Array(features.length);

    console.log("Pass 1: Analysis & Topology...");
    for (let i = 0; i < features.length; i++) {
        const cleaned = cleanUpPoints(allSplitPoints[i]!);
        if (cleaned.length < 2) continue;
        processedFeatures[i] = cleaned;
        const startNodeId = getOrCreateNodeId(cleaned[0]!);
        const endNodeId = getOrCreateNodeId(cleaned[cleaned.length - 1]!);
        const startBrng = getBearing(cleaned[0]!, cleaned[1]!);
        const endBrng = getBearing(
            cleaned[cleaned.length - 2]!,
            cleaned[cleaned.length - 1]!,
        );

        if (!nodeTopology.has(startNodeId)) nodeTopology.set(startNodeId, []);
        nodeTopology
            .get(startNodeId)!
            .push({ fIdx: i, isStart: true, bearing: startBrng });
        if (!nodeTopology.has(endNodeId)) nodeTopology.set(endNodeId, []);
        nodeTopology
            .get(endNodeId)!
            .push({ fIdx: i, isStart: false, bearing: endBrng });
    }

    console.log("Pass 2: Topology Inference...");
    const directionInference = new Int8Array(features.length);
    for (let i = 0; i < features.length; i++) {
        const pts = processedFeatures[i];
        if (!pts) continue;
        const startNodeId = nodeMap.get(coordKey(pts[0]!))!;
        const endNodeId = nodeMap.get(coordKey(pts[pts.length - 1]!))!;
        const myStartBrng = getBearing(pts[0]!, pts[1]!);
        const myEndBrng = getBearing(
            pts[pts.length - 2]!,
            pts[pts.length - 1]!,
        );

        let fVotes = 0,
            bVotes = 0;
        const check = (
            neighbors: any[],
            myBrng: number,
            isStartSide: boolean,
        ) => {
            for (const n of neighbors) {
                if (n.fIdx === i) continue;
                let diff = Math.abs(n.bearing - myBrng);
                if (diff > 180) diff = 360 - diff;
                if (diff < 60) {
                    if (isStartSide) n.isStart ? bVotes++ : fVotes++;
                    else n.isStart ? fVotes++ : bVotes++;
                }
            }
        };
        check(nodeTopology.get(startNodeId) || [], myStartBrng, true);
        check(nodeTopology.get(endNodeId) || [], myEndBrng, false);
        directionInference[i] = fVotes > bVotes ? 1 : bVotes > fVotes ? -1 : 0;
    }

    console.log("Pass 3: Generating Edges...");
    for (let i = 0; i < features.length; i++) {
        const pts = processedFeatures[i];
        if (!pts) continue;

        const props = features[i]!.properties;
        const isRoundabout = props.roadType === "roundabout";
        const isFreeway =
            props.roadType === "freeway" || props.roadType === "divided";
        const isManual = props.roadType === "manual";
        const inferredDir = directionInference[i];

        // RESTORED FERRY LOGIC
        const roadTypeValue =
            props.type === "ferry"
                ? 4
                : (roadTypeMap[props.roadType] ?? roadTypeMap[props.type] ?? 0);

        for (let j = 0; j < pts.length - 1; j++) {
            const u = getOrCreateNodeId(pts[j]!);
            const v = getOrCreateNodeId(pts[j + 1]!);
            const dist = Math.round(haversine(pts[j]!, pts[j + 1]!) * 10) / 10;

            let fw = dist,
                bw = dist;
            if (isRoundabout || isManual) bw = Infinity;
            else if (isFreeway) {
                if (inferredDir === 1) bw += 300;
                else if (inferredDir === -1) fw += 300;
            }

            if (fw !== Infinity)
                edges.push({
                    from: u,
                    to: v,
                    w: fw,
                    r: roadTypeValue,
                    dlc: props.required_dlc || 0,
                });
            if (bw !== Infinity)
                edges.push({
                    from: v,
                    to: u,
                    w: bw,
                    r: roadTypeValue,
                    dlc: props.required_dlc || 0,
                });
        }
    }
    return { nodes, edges };
}

//// SAVES THE NODES.JSON AND EDGES.JSON TO DISK
//// BUILD GRAPH
function buildGraph(inputPath: string, outDir: string) {
    console.log("Loading GeoJSON...");
    const geo = JSON.parse(readFileSync(inputPath, "utf8")) as InputGeoJSON;

    const validFeatures = geo.features.filter(
        (f) => f.geometry?.coordinates?.length >= 2,
    );
    validFeatures.forEach((f) => {
        if (!f.properties.roadType) f.properties.roadType = "local";
    });

    const allSplitPoints = storeFeaturePoints(validFeatures);
    const { nodes, edges } = createNodesAndEdges(validFeatures, allSplitPoints);

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
        path.join(outDir, "nodes.json"),
        JSON.stringify(
            nodes.map((n) => [
                Math.round(n.lat * 1e5),
                Math.round(n.lng * 1e5),
            ]),
        ),
    );
    writeFileSync(
        path.join(outDir, "edges.json"),
        JSON.stringify(edges.map((e) => [e.from, e.to, e.w, e.r, e.dlc])),
    );

    console.log(`Finished: ${nodes.length} nodes, ${edges.length} edges.`);
}

// Main call
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error(
            "Usage: npx ts-node app/scripts/buildGraph.ts <input.geojson> <outDir>",
        );
        process.exit(1);
    }
    const [inputPath, outDir] = args;
    await buildGraph(inputPath!, outDir!);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
