import Foundation

/// The Header step's district, county and route choices and the Location
/// section's links and northing/easting, from the Expo GISA editor.
extension GisaForm {
    /// Choosing a district keeps the county only if it is in that district,
    /// and the route only if that county has it.
    public mutating func chooseDistrict(_ district: String) {
        let county = CaltransCounties.county(self["county"])
        let countyStays = county?.district == district
        self["district"] = district
        if !countyStays { self["county"] = "" }
        if !countyStays || !CaltransCounties.routes(forCounty: county?.code).contains(self["route"]) {
            self["route"] = ""
        }
    }

    /// Choosing a county sets its district and clears a route it does not have.
    ///
    /// The Expo editor compared the stored route ("080") with the county's
    /// unpadded list ("80"), so it cleared every one- or two-digit route; here
    /// both sides are padded, as was intended.
    public mutating func chooseCounty(_ code: String) {
        guard let county = CaltransCounties.county(code) else { return }
        self["county"] = county.code
        self["district"] = county.district
        if !self["route"].isEmpty && !CaltransCounties.routes(forCounty: county.code).contains(self["route"]) {
            self["route"] = ""
        }
    }

    /// The latitude and longitude, when both are numbers.
    public var coordinate: (latitude: Double, longitude: Double)? {
        guard let latitude = GisaPrecision.coordinateValue(self["latitude"]),
              let longitude = GisaPrecision.coordinateValue(self["longitude"]) else { return nil }
        return (latitude, longitude)
    }

    /// An Esri World Imagery snapshot around the location (no sign-in needed).
    public var mapPreviewURL: URL? {
        guard let (latitude, longitude) = coordinate else { return nil }
        let span = 0.006
        var components = URLComponents(string: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export")!
        components.queryItems = [
            URLQueryItem(name: "bbox", value: "\(longitude - span),\(latitude - span),\(longitude + span),\(latitude + span)"),
            URLQueryItem(name: "bboxSR", value: "4326"), URLQueryItem(name: "imageSR", value: "4326"),
            URLQueryItem(name: "size", value: "1200,600"), URLQueryItem(name: "format", value: "jpg"),
            URLQueryItem(name: "f", value: "image"),
        ]
        return components.url
    }

    /// The location in Google Maps.
    public var googleMapsURL: URL? {
        guard let (latitude, longitude) = coordinate else { return nil }
        let pair = "\(JS.numberText(latitude)),\(JS.numberText(longitude))"
        let place = pair.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))) ?? pair
        return URL(string: "https://www.google.com/maps/place/\(place)/@\(pair),17z")
    }

    /// The CCS83 zone and the location's northing and easting as text; nil when
    /// the county has no zone. The two values are "" until the location is set.
    public var statePlane: (zone: Int, northing: String, easting: String)? {
        guard let zone = CaliforniaStatePlane.zone(forCounty: self["county"]) else { return nil }
        guard let (latitude, longitude) = coordinate,
              let point = CaliforniaStatePlane.northingEasting(latitude: latitude, longitude: longitude,
                                                               county: self["county"]) else {
            return (zone, "", "")
        }
        return (zone, CaliforniaStatePlane.format(point.northing), CaliforniaStatePlane.format(point.easting))
    }

    /// Sets the latitude and longitude from a typed northing and easting (US
    /// survey feet, commas allowed). Returns a message when they cannot be used.
    public mutating func applyStatePlane(northing: String, easting: String) -> String? {
        func feet(_ text: String) -> Double? {
            JS.number(text.replacingOccurrences(of: ",", with: "")).flatMap { $0.isFinite ? $0 : nil }
        }
        guard let north = feet(northing), let east = feet(easting) else {
            return "Northing and easting must be numeric."
        }
        guard let point = CaliforniaStatePlane.latLon(northing: north, easting: east, county: self["county"]) else {
            return "Unable to convert northing/easting for the selected county."
        }
        self["latitude"] = GisaPrecision.formatCoordinate(JS.numberText(point.latitude))
        self["longitude"] = GisaPrecision.formatCoordinate(JS.numberText(point.longitude))
        return nil
    }
}

/// "04-ALA-880-12.30 - 10/28/26, 09:00 AM", the line under a submission's
/// title. Ported from buildSubmissionDescriptor in mobile/src/utils/submissionLabel.ts.
public enum SubmissionDescriptor {
    public static func text(district: String?, county: String?, route: String?, postMile: String?,
                            createdAt: String?) -> String {
        func part(_ value: String?) -> String { value?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? "?" }
        let base = [part(district), part(county), GisaPrecision.routeInput(route ?? "").nilIfEmpty ?? "?",
                    GisaPrecision.postMileInput(postMile ?? "").nilIfEmpty ?? "?"].joined(separator: "-")
        guard let date = ServerDate.parse(createdAt) else { return base }
        let when = date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).year(.twoDigits).hour().minute())
        return "\(base) - \(when)"
    }
}
