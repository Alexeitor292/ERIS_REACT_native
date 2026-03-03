GISA_DISTRIBUTION_LUT = [
    {"code": "ADVANCING", "label": "Advancing", "sort_order": 10},
    {"code": "RETROGRESSING", "label": "Retrogressing", "sort_order": 20},
    {"code": "ENLARGING", "label": "Enlarging", "sort_order": 30},
    {"code": "WIDENING", "label": "Widening", "sort_order": 40},
    {"code": "MOVING", "label": "Moving", "sort_order": 50},
    {"code": "CONFINED", "label": "Confined", "sort_order": 60},
]

GISA_HIGHWAY_STATUS_LUT = [
    {"code": "OPEN", "label": "Open", "sort_order": 10},
    {"code": "SHOULDER_CLOSED", "label": "Shoulder Closed", "sort_order": 20},
    {"code": "LANES_CLOSED", "label": "Lane(s) Closed", "sort_order": 30},
    {"code": "ONE_WAY_CLOSED", "label": "One-way Closed", "sort_order": 40},
    {"code": "TWO_WAY_CLOSED", "label": "Two-way Closed", "sort_order": 50},
]

GISA_INCIDENT_TYPE_LUT = [
    {"code": "ROCK_FALL", "label": "Rock Fall", "sort_order": 10},
    {"code": "TOPPLE", "label": "Topple", "sort_order": 20},
    {"code": "SLIDE", "label": "Slide", "sort_order": 30},
    {"code": "SPREAD", "label": "Spread", "sort_order": 40},
    {"code": "FLOW", "label": "Flow", "sort_order": 50},
    {"code": "COMPOUND", "label": "Compound", "sort_order": 60},
    {"code": "EROSION", "label": "Erosion", "sort_order": 70},
    {"code": "SURFICIAL_SLOUGHING", "label": "Surficial Sloughing", "sort_order": 80},
    {"code": "SCOURED_TOE", "label": "Scoured Toe", "sort_order": 90},
    {"code": "WASHOUT", "label": "Washout", "sort_order": 100},
]

GISA_ACTION_LUT = [
    {"code": "OPEN_HIGHWAY_TRAFFIC", "label": "Open highway traffic", "action_group": "IMMEDIATE", "sort_order": 10},
    {"code": "CLOSE_HIGHWAY_SHOULDER", "label": "Close highway shoulder", "action_group": "IMMEDIATE", "sort_order": 20},
    {"code": "CLOSE_ONE_DIRECTION", "label": "Close highway one direction", "action_group": "IMMEDIATE", "sort_order": 30},
    {"code": "CLOSE_BOTH_DIRECTIONS", "label": "Close highway both directions", "action_group": "IMMEDIATE", "sort_order": 40},
    {"code": "REMOVE_DEBRIS", "label": "Remove landslide debris", "action_group": "IMMEDIATE", "sort_order": 50},
    {"code": "PLACE_K_RAIL", "label": "Place K-rail or fence", "action_group": "IMMEDIATE", "sort_order": 60},
    {"code": "COVER_SLOPE_PLASTIC", "label": "Cover slope with plastic", "action_group": "IMMEDIATE", "sort_order": 70},
    {"code": "DIVERT_SURFACE_WATER", "label": "Divert surface water", "action_group": "IMMEDIATE", "sort_order": 80},
    {"code": "REMOVE_CULVERT_BLOCKAGE", "label": "Remove culvert blockage", "action_group": "IMMEDIATE", "sort_order": 90},
    {"code": "DEWATER", "label": "Dewater", "action_group": "IMMEDIATE", "sort_order": 100},
    {"code": "DEWATER_HORIZONTAL_DRAINS", "label": "Dewater with horizontal drains", "action_group": "IMMEDIATE", "sort_order": 105},
    {"code": "TEMP_SHORING", "label": "Construct temporary shoring", "action_group": "IMMEDIATE", "sort_order": 110},
    {"code": "BUTTRESS_TOE", "label": "Buttress toe", "action_group": "IMMEDIATE", "sort_order": 120},
    {"code": "PLACE_ROCK_SLOPE_PROTECTION", "label": "Place rock slope protection (ref. manual)", "action_group": "IMMEDIATE", "sort_order": 130},
    {"code": "ROUTINE_VISUAL_MONITOR", "label": "Routine visual monitor", "action_group": "FOLLOW_UP", "sort_order": 10},
    {"code": "RECONSTRUCT_SLOPE", "label": "Reconstruct slope", "action_group": "FOLLOW_UP", "sort_order": 20},
    {"code": "RECONSTRUCT_SLOPE_GEOSYNTHETICS", "label": "Reconstruct slope with geosynthetics", "action_group": "FOLLOW_UP", "sort_order": 25},
    {"code": "REPAIR_CULVERT_DRAINAGE_PIPE", "label": "Repair culvert/drainage pipe", "action_group": "FOLLOW_UP", "sort_order": 28},
    {"code": "EROSION_CONTROL", "label": "Install erosion control", "action_group": "FOLLOW_UP", "sort_order": 30},
    {"code": "SURVEY_SITE_DIST_SURVEY", "label": "Survey site - district survey", "action_group": "FOLLOW_UP", "sort_order": 35},
    {"code": "GEOLOGIC_MAPPING", "label": "Perform geologic mapping", "action_group": "FOLLOW_UP", "sort_order": 40},
    {"code": "SUBSURFACE_EXPLORATION", "label": "Perform subsurface exploration", "action_group": "FOLLOW_UP", "sort_order": 50},
    {"code": "DETAILED_DESIGN_PLANS", "label": "Detailed design & plans", "action_group": "FOLLOW_UP", "sort_order": 60},
]

GISA_DISTRIBUTION_CODES = {x["code"] for x in GISA_DISTRIBUTION_LUT}
GISA_HIGHWAY_STATUS_CODES = {x["code"] for x in GISA_HIGHWAY_STATUS_LUT}
GISA_INCIDENT_TYPE_CODES = {x["code"] for x in GISA_INCIDENT_TYPE_LUT}
GISA_ACTION_CODE_TO_GROUP = {x["code"]: x["action_group"] for x in GISA_ACTION_LUT}
