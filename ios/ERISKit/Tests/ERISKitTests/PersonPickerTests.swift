import XCTest
@testable import ERISKit

/// Ported from web/src/features/assessments/personPickerModel.test.ts. The
/// keyboard-navigation tests stay on the web: the phone has no arrow keys.
final class PersonPickerTests: XCTestCase {
    private func person(_ id: Int, _ name: String, group: String?, branchId: Int? = nil, branchName: String? = nil,
                        homeCity: String? = nil, homeDistrict: String? = nil, open: Int = 0,
                        availability: String = "AVAILABLE", until: String? = nil) -> RoutingUserOption {
        RoutingUserOption(id: id, fullName: name, officeCode: "WEST", officeName: "Office of Geotechnical Design West",
                          branchId: branchId, branchName: branchName, homeCity: homeCity, homeDistrict: homeDistrict,
                          openAssessmentCount: open, availability: availability, availableUntil: until, groupKey: group)
    }

    private let branchC = PickerGroup(groupKey: "b:3", label: "Branch C", branchId: 3, branchLetter: "C",
                                      branchName: "Branch C", homeCity: "Oakland", homeDistrict: "04",
                                      acceptsAssignments: true, isActive: true)
    private let branchEUnstaffed = PickerGroup(groupKey: "b:5", label: "Branch E", branchId: 5, branchLetter: "E",
                                               branchName: "Branch E", homeCity: "San Bernardino", homeDistrict: "08",
                                               acceptsAssignments: false, isActive: true)

    func testASingleCandidateIsStillNotChosenForYou() {
        let sections = PersonPicker.sections(groups: [branchC],
                                             items: [person(41, "A. Rivera", group: "b:3", branchId: 3, branchName: "Branch C")])
        XCTAssertNil(PersonPicker.initialValue(sections))
        XCTAssertNil(PersonPicker.selectedPerson(sections, PersonPicker.initialValue(sections)))
        // The option is there to be chosen: it is the selection that is empty.
        XCTAssertEqual(PersonPicker.flatten(sections).count, 1)
        XCTAssertEqual(PersonPicker.selectedPerson(sections, 41)?.fullName, "A. Rivera")
    }

    func testNoDataShapeYieldsAValueWithoutAnExplicitChoice() {
        let shapes: [([PickerGroup], [RoutingUserOption])] = [
            ([], []),
            ([branchC], []),
            ([branchC], [person(1, "Solo", group: "b:3")]),
            ([branchC, branchEUnstaffed], [person(1, "Solo", group: "b:5")]),
            ([], [person(9, "Orphan", group: "b:99")]),
        ]
        for (groups, items) in shapes {
            XCTAssertNil(PersonPicker.initialValue(PersonPicker.sections(groups: groups, items: items)))
        }
    }

    func testARotatedOutPersonIsShownWithTheirReturnDateNeverDropped() {
        let away = person(7, "B. Nakamura", group: "b:3", branchId: 3, branchName: "Branch C",
                          availability: "ROTATION_OUT", until: "2027-02-05")
        let sections = PersonPicker.sections(groups: [branchC], items: [person(6, "A. Rivera", group: "b:3"), away])
        XCTAssertEqual(PersonPicker.flatten(sections).map(\.id), [6, 7])
        XCTAssertEqual(PersonPicker.selectable(sections).map(\.id), [6, 7])
        XCTAssertEqual(away.availabilityNote, "Rotation out — back 2/5/27")
        XCTAssertNil(PersonPicker.availabilityNote(availability: "AVAILABLE", until: nil))
        XCTAssertEqual(PersonPicker.availabilityNote(availability: "ACTING_ELSEWHERE", until: nil), "Acting elsewhere")
        XCTAssertEqual(PersonPicker.availabilityNote(availability: "UNAVAILABLE", until: "2026-11-30"),
                       "Unavailable — back 11/30/26")
    }

    func testADateOnlyReturnDateDoesNotShiftADayInAWesternTimeZone() {
        XCTAssertEqual(PersonPicker.formatAvailabilityDate("2027-02-05"), "2/5/27")
        XCTAssertEqual(PersonPicker.formatAvailabilityDate("2027-02-05T00:00:00"), "2/5/27")
        XCTAssertEqual(PersonPicker.formatAvailabilityDate("2030-01-09"), "1/9/30")
        XCTAssertNil(PersonPicker.formatAvailabilityDate(nil))
        XCTAssertNil(PersonPicker.formatAvailabilityDate(""))
    }

    func testAnUnstaffedBranchIsReturnedDisabledWithItsReasonNotOmitted() {
        let sections = PersonPicker.sections(groups: [branchC, branchEUnstaffed],
                                             items: [person(1, "A. Rivera", group: "b:3"), person(2, "C. Ferrand", group: "b:5")])
        XCTAssertEqual(sections.map(\.label), ["Branch C", "Branch E"])
        XCTAssertNil(sections[0].disabledReason)
        XCTAssertEqual(sections[1].disabledReason, "Branch E is not staffed yet")
        // Shown, but not choosable.
        XCTAssertEqual(PersonPicker.flatten(sections).map(\.id), [1, 2])
        XCTAssertEqual(PersonPicker.selectable(sections).map(\.id), [1])
        let retired = PickerGroup(groupKey: "b:3", label: "Branch C", branchId: 3, branchLetter: "C",
                                  branchName: "Branch C", isActive: false)
        XCTAssertEqual(PersonPicker.disabledReason(retired), "Branch C has been retired")
    }

    func testGroupsKeepTheServersOrderAndAnEmptyBranchStillAppears() {
        let sections = PersonPicker.sections(groups: [branchC, branchEUnstaffed], items: [])
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections.map(\.items.count), [0, 0])
        XCTAssertEqual(sections[0].place, "Oakland D4")
    }

    func testAPersonWhoseGroupIsMissingLandsInATrailingGroupRatherThanVanishing() {
        let orphan = person(88, "Z. Unknown", group: "b:404")
        let sections = PersonPicker.sections(groups: [branchC], items: [person(1, "A. Rivera", group: "b:3"), orphan])
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections[1].label, "Not in a listed group")
        XCTAssertEqual(PersonPicker.flatten(sections).map(\.id), [1, 88])
        // No group key at all is the same case.
        let keyless = PersonPicker.sections(groups: [branchC], items: [person(5, "No Key", group: nil)])
        XCTAssertEqual(keyless.last?.items.map(\.id), [5])
    }

    func testWorkloadReadsAboutAThirdPartyAndNeverBecomesAnOrdering() {
        XCTAssertEqual(PersonPicker.workloadNote(open: 4, awaiting: 2), "4 open · 2 waiting on them")
        XCTAssertEqual(PersonPicker.workloadNote(open: 4, awaiting: 0), "4 open")
        XCTAssertEqual(PersonPicker.workloadNote(open: 0, awaiting: 0), "No open assessments")
        // Order comes from the payload; the model never re-sorts by load.
        let busy = person(1, "A. Rivera", group: "b:3", open: 9)
        let idle = person(2, "B. Nakamura", group: "b:3", open: 0)
        XCTAssertEqual(PersonPicker.flatten(PersonPicker.sections(groups: [branchC], items: [busy, idle])).map(\.id), [1, 2])
    }

    func testLocationAndBranchLabelsDegradeOnePartAtATime() {
        XCTAssertEqual(PersonPicker.districtLabel("04"), "D4")
        XCTAssertEqual(PersonPicker.districtLabel("11"), "D11")
        XCTAssertNil(PersonPicker.districtLabel(nil))
        XCTAssertEqual(PersonPicker.placeLabel(city: "Oakland", district: "04"), "Oakland D4")
        XCTAssertEqual(PersonPicker.placeLabel(city: "Sacramento", district: nil), "Sacramento")
        XCTAssertEqual(PersonPicker.placeLabel(city: nil, district: "07"), "D7")
        XCTAssertNil(PersonPicker.placeLabel(city: nil, district: nil))
        XCTAssertEqual(PersonPicker.branchLabel(name: "Districts Branch A", letter: "A"), "Districts Branch A")
        XCTAssertEqual(PersonPicker.branchLabel(name: nil, letter: "F"), "Branch F")
        XCTAssertNil(PersonPicker.branchLabel(name: nil, letter: nil))
        XCTAssertEqual(person(1, "A", group: "b:3", branchName: "Branch C", homeCity: "Oakland", homeDistrict: "04").placeNote,
                       "Branch C · Oakland D4")
    }

    func testAnOutOfBranchStaffChoiceIsRecognisedBeforeTheServerRefusesIt() {
        let inBranch = person(1, "A. Rivera", group: "b:3", branchId: 3)
        let elsewhere = person(2, "B. Nakamura", group: "b:4", branchId: 4)
        let noBranch = person(3, "C. Ferrand", group: "UNASSIGNED", branchId: nil)
        XCTAssertFalse(PersonPicker.isOutOfBranchChoice(inBranch, assessmentBranchId: 3))
        XCTAssertTrue(PersonPicker.isOutOfBranchChoice(elsewhere, assessmentBranchId: 3))
        // Unknown on either side is not a warning: the server decides.
        XCTAssertFalse(PersonPicker.isOutOfBranchChoice(noBranch, assessmentBranchId: 3))
        XCTAssertFalse(PersonPicker.isOutOfBranchChoice(elsewhere, assessmentBranchId: nil))
        XCTAssertFalse(PersonPicker.isOutOfBranchChoice(nil, assessmentBranchId: 3))
    }
}
