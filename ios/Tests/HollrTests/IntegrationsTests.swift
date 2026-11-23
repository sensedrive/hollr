import XCTest
@testable import Hollr

final class IntegrationsTests: XCTestCase {
    func testStatusDecodesWithoutToken() throws {
        let json = #"{"jira":{"site":"x.atlassian.net","email":"a@b.de","account":"Anna","updatedAt":"2026-11-23T10:00:00Z","token":"SECRET"}}"#
        let status = try JSONDecoder().decode(HollrClient.SecretsStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.jira, HollrClient.JiraStatus(site: "x.atlassian.net", email: "a@b.de", account: "Anna",
                                                            updatedAt: "2026-11-23T10:00:00Z"))
        XCTAssertFalse(String(describing: status).contains("SECRET"))
    }

    func testStatusWithoutJira() throws {
        let status = try JSONDecoder().decode(HollrClient.SecretsStatus.self, from: Data(#"{"jira":null}"#.utf8))
        XCTAssertNil(status.jira)
    }

    func testSiteNormalisation() {
        XCTAssertEqual(JiraSite.normalized("https://Leicht-Luftig.atlassian.net/"), "leicht-luftig.atlassian.net")
        XCTAssertEqual(JiraSite.normalized(" foo.atlassian.net "), "foo.atlassian.net")
        XCTAssertNil(JiraSite.normalized("http://foo.atlassian.net"))
        XCTAssertNil(JiraSite.normalized("foo.example.com"))
        XCTAssertNil(JiraSite.normalized("-foo.atlassian.net"))
    }
}
