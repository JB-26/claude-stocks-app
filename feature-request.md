# Executive Summary

This feature request is about allowing the user to have multiple stock views displayed at the same time.

The views available would be:
- To allow the user have two companies side by side. This will be called **split view**
- To allow the user to have three views, in a bento box style of two on top and one on the bottom. This will be called **multi view**

The user can also remove the view back to the single default view.

The views will be available next to the stocks dropdown, a natural choice for the user.

# User Stories

Given I am on the dashboard page
When I select the views menu
And I chose the split view option
Then I will see my current company, and the company at the top of the dropdown list.

Given I am on the dashboard page
When I select the views menu
And I chose the multi view option
Then I will see my current company, the company at the top of the dropdown list and the next company in the dropdown list.

Given I am on the dashboard page
And I have the split view selected
When I select the default view
Then I will see my current company only.

Given I am on the dashboard page
And I have the multi view selected
When I select the default view
Then I will see my current company only.

# Testing

The user stories should be used as a guidance for the E2E testing and unit tests.