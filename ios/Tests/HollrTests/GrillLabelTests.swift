import XCTest
@testable import Hollr

final class GrillLabelTests: XCTestCase {
    func testTickets() {
        XCTAssertEqual(GrillLabel.ticket("Grill TENDR-1071 · #3551"), "TENDR-1071:3551")
        XCTAssertEqual(GrillLabel.ticket("Auto-Grill TENDR-1071 · #3551"), "TENDR-1071:3551")
        XCTAssertEqual(GrillLabel.ticket("Grill #12"), ":12")
        XCTAssertEqual(GrillLabel.ticket("Auto-Grill #12"), ":12")
        XCTAssertEqual(GrillLabel.ticket("Grill TENDR-1"), "TENDR-1:")
    }

    func testOtherLabels() {
        for label in ["Grillen #3", "grill #3", "Grill tendr-1 · #3", "Sandcastle haccp", ""] {
            XCTAssertNil(GrillLabel.ticket(label), label)
        }
    }

    func testFragment() {
        let url = URL(string: "http://localhost:5/#token=ab")!
        XCTAssertEqual(GrillLabel.url(url, opening: "TENDR-1:3").absoluteString, "http://localhost:5/#token=ab&open=TENDR-1%3A3")
        XCTAssertEqual(GrillLabel.url(url, opening: nil), url)
    }
}
